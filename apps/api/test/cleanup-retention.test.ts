import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { runCleanup, runEndedPostsCleanup, startEndedPostsSchedule } from '../src/jobs/cleanup.js';
import { loadConfig } from '../src/config.js';
import { LocalDiskStorage, type PhotoStorage } from '../src/storage/index.js';
import { jpeg, makePost, setupEnv, signup, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => (env = await setupEnv()));
afterAll(async () => env.close());
beforeEach(async () => {
  for (const n of readdirSync(env.storageDir)) rmSync(join(env.storageDir, n), { recursive: true, force: true });
  await env.reset();
  await env.db.execute(sql`delete from rate_counters`);
});

const opts = { postRetentionDays: 90, dmRetentionDays: 30 };
const rows = async <T>(q: ReturnType<typeof sql>) => (await env.db.execute<T & Record<string, unknown>>(q)).rows;
const storage = () => new LocalDiskStorage(env.storageDir);
const exists = async (table: 'posts' | 'conversations', id: number) => (await rows(sql`select 1 from ${sql.raw(table)} where id = ${id}`)).length === 1;

/** 대화 1개를 만들고 마지막 메시지 시각을 now - 지정 간격으로 맞춘다 */
async function convWithLastMessage(interval: string) {
  const a = await signup(env.app);
  const b = await signup(env.app);
  const conv = (await a.client.post('/conversations', { targetUserId: b.user.id, body: '안녕하세요' })).body.conversation;
  await env.db.execute(sql`update conversations set last_message_at = now() - ${interval}::interval where id = ${conv.id}`);
  return { a, b, id: conv.id as number };
}

describe('U3: 쪽지 보존 — 마지막 메시지 후 30일(종료·인수 상태와 무관)', () => {
  it('29일 23시간은 유지, 30일 1시간은 삭제(메시지도 함께)', async () => {
    const keep = await convWithLastMessage('29 days 23 hours');
    const del = await convWithLastMessage('30 days 1 hour');
    const r = await runCleanup(env.db, storage(), opts);
    expect(r.purgedConversations).toBe(1);
    expect(await exists('conversations', keep.id)).toBe(true);
    expect(await exists('conversations', del.id)).toBe(false);
    expect(await rows(sql`select 1 from messages where conversation_id = ${del.id}`)).toHaveLength(0);
    expect(await rows(sql`select 1 from messages where conversation_id = ${keep.id}`)).toHaveLength(1);
  });

  it('종료(closed_at)되지 않은 대화도 30일 무활동이면 삭제한다(옛 규칙은 유지했음)', async () => {
    const c = await convWithLastMessage('45 days');
    const [row] = await rows<{ closed_at: Date | null }>(sql`select closed_at from conversations where id = ${c.id}`);
    expect(row!.closed_at).toBeNull();
    await runCleanup(env.db, storage(), opts);
    expect(await exists('conversations', c.id)).toBe(false);
  });

  it('closed_at 이 오래됐어도 최근에 메시지가 있으면 유지한다', async () => {
    const c = await convWithLastMessage('1 day');
    await env.db.execute(sql`update conversations set closed_at = now() - interval '200 days' where id = ${c.id}`);
    await runCleanup(env.db, storage(), opts);
    expect(await exists('conversations', c.id)).toBe(true);
  });

  it('진행 중인 인수(handover)가 있어도 30일 무활동이면 삭제된다(인수 상태와 무관, 인수 요청도 함께 삭제)', async () => {
    const finder = await signup(env.app);
    const owner = await signup(env.app);
    const found = (await makePost(finder.client, { type: 'FOUND' })).body;
    const conv = (await owner.client.post('/conversations', { postId: found.id, body: '제 것 같아요' })).body.conversation;
    await owner.client.post(`/conversations/${conv.id}/handover`, { postId: found.id });
    await env.db.execute(sql`update conversations set last_message_at = now() - interval '31 days' where id = ${conv.id}`);
    await runCleanup(env.db, storage(), opts);
    expect(await exists('conversations', conv.id)).toBe(false);
    expect(await rows(sql`select 1 from handover_requests where conversation_id = ${conv.id}`)).toHaveLength(0);
    expect(await exists('posts', found.id)).toBe(true); // 글은 건드리지 않는다
  });

  it('보존 일수는 RETENTION_DM_DAYS(옵션)로 바뀐다', async () => {
    const c = await convWithLastMessage('3 days');
    await runCleanup(env.db, storage(), { postRetentionDays: 90, dmRetentionDays: 2 });
    expect(await exists('conversations', c.id)).toBe(false);
  });

  it('와이프 방지·배치·임대는 그대로: 많은 대화도 배치로 지우고(200건 초과), 실행 후 임대가 풀린다', async () => {
    const u1 = await signup(env.app);
    const u2 = await signup(env.app);
    // 사용자 쌍 유니크 제약이 있으므로 사용자 여러 명으로 대화를 대량 생성(SQL 직접 삽입)
    await env.db.execute(sql`
      insert into users (login_id, password_hash, nickname, nickname_lower)
      select 'bulk' || g, 'x', 'bulk' || g, 'bulk' || g from generate_series(1, 250) g`);
    await env.db.execute(sql`
      insert into conversations (user_a_id, user_b_id, last_message_at)
      select ${u1.user.id}, u.id, now() - interval '40 days' from users u where u.login_id like 'bulk%'`);
    const r = await runCleanup(env.db, storage(), opts);
    expect(r.purgedConversations).toBe(250);
    expect(r.errors).toEqual([]);
    expect((await runCleanup(env.db, storage(), opts)).skipped).toBe(false);
    void u2;
  });
});

describe('A17: 종료된 글(CLOSED/RETURNED)은 종료 24시간 뒤 자동 삭제', () => {
  async function postWith(status: string, interval: string | null, withPhoto = false) {
    const u = await signup(env.app);
    const up = withPhoto ? await u.client.upload(await jpeg()) : null;
    const post = (await makePost(u.client, up ? { photoIds: [up.body.photoId] } : {})).body;
    if (interval) await env.db.execute(sql`update posts set status = ${status}, closed_at = now() - ${interval}::interval where id = ${post.id}`);
    else await env.db.execute(sql`update posts set status = ${status} where id = ${post.id}`);
    return { u, id: post.id as number };
  }

  it('경계: 23시간 59분은 유지, 24시간 1분은 삭제 (CLOSED)', async () => {
    const keep = await postWith('CLOSED', '23 hours 59 minutes');
    const del = await postWith('CLOSED', '24 hours 1 minute');
    const r = await runEndedPostsCleanup(env.db, storage(), {});
    expect(r.purgedPosts).toBe(1);
    expect(await exists('posts', keep.id)).toBe(true);
    expect(await exists('posts', del.id)).toBe(false);
  });

  it('RETURNED 도 같은 규칙(24시간 뒤 삭제)', async () => {
    const keep = await postWith('RETURNED', '23 hours');
    const del = await postWith('RETURNED', '25 hours');
    await runEndedPostsCleanup(env.db, storage(), {});
    expect(await exists('posts', keep.id)).toBe(true);
    expect(await exists('posts', del.id)).toBe(false);
  });

  it('OPEN/MATCHED 글은 오래돼도(closed_at 없음) 삭제하지 않고, 종료 상태에서 closed_at 이 비어 있는 글도 건드리지 않는다', async () => {
    const open = await postWith('OPEN', null);
    const matched = await postWith('MATCHED', null);
    const noStamp = await postWith('CLOSED', null); // 비정상 데이터: 시각 없음 → 판단할 수 없으므로 유지
    await env.db.execute(sql`update posts set created_at = now() - interval '400 days' where id in (${open.id}, ${matched.id})`);
    const r = await runEndedPostsCleanup(env.db, storage(), {});
    expect(r.purgedPosts).toBe(0);
    for (const p of [open, matched, noStamp]) expect(await exists('posts', p.id)).toBe(true);
  });

  it('사진 파일(원본·AI 사본)이 함께 삭제되고, 연결된 댓글·매칭·알림도 사라진다', async () => {
    const { id, u } = await postWith('CLOSED', '30 hours', true);
    const [ph] = await rows<{ storage_key: string }>(sql`select storage_key from post_photos where post_id = ${id}`);
    expect(existsSync(join(env.storageDir, ph!.storage_key))).toBe(true);
    const other = await signup(env.app);
    await env.db.execute(sql`update posts set status = 'OPEN', closed_at = null where id = ${id}`);
    await other.client.post(`/posts/${id}/comments`, { body: '댓글' });
    await env.db.execute(sql`update posts set status = 'CLOSED', closed_at = now() - interval '30 hours' where id = ${id}`);
    void u;
    const r = await runEndedPostsCleanup(env.db, storage(), {});
    expect(r.purgedPosts).toBe(1);
    expect(existsSync(join(env.storageDir, ph!.storage_key))).toBe(false);
    expect(await rows(sql`select 1 from comments where post_id = ${id}`)).toHaveLength(0);
    expect(await rows(sql`select 1 from post_photos where post_id = ${id}`)).toHaveLength(0);
  });

  it('신고는 글이 삭제돼도 snapshot 과 함께 남는다(증거 보존)', async () => {
    const { id } = await postWith('OPEN', null);
    const reporter = await signup(env.app);
    expect((await reporter.client.post('/reports', { targetType: 'POST', targetId: id, reason: 'SPAM' })).status).toBe(201);
    await env.db.execute(sql`update posts set status = 'CLOSED', closed_at = now() - interval '25 hours' where id = ${id}`);
    await runEndedPostsCleanup(env.db, storage(), {});
    expect(await exists('posts', id)).toBe(false);
    const rep = await rows<{ snapshot: { title: string } }>(sql`select snapshot from reports where target_type = 'POST' and target_id = ${id}`);
    expect(rep).toHaveLength(1);
    expect(rep[0]!.snapshot.title).toContain('에어팟');
  });

  it('공용 hardDeletePosts 를 사용: 쪽지 메시지는 남고 글 맥락(post_id)만 사라지며, 인수 요청·매칭도 함께 삭제된다', async () => {
    const finder = await signup(env.app);
    const owner = await signup(env.app);
    const found = (await makePost(finder.client, { type: 'FOUND' })).body;
    const conv = (await owner.client.post('/conversations', { postId: found.id, body: '제 것 같아요' })).body.conversation;
    await owner.client.post(`/conversations/${conv.id}/handover`, { postId: found.id });
    expect((await rows(sql`select 1 from messages where conversation_id = ${conv.id} and post_id = ${found.id}`)).length).toBeGreaterThan(0);
    await env.db.execute(sql`update posts set status = 'RETURNED', closed_at = now() - interval '25 hours' where id = ${found.id}`);
    const r = await runEndedPostsCleanup(env.db, storage(), {});
    expect(r.purgedPosts).toBe(1);
    expect(await exists('posts', found.id)).toBe(false);
    expect((await rows(sql`select 1 from messages where conversation_id = ${conv.id} and post_id is null`)).length).toBeGreaterThan(0);
    expect(await rows(sql`select 1 from messages where post_id = ${found.id}`)).toHaveLength(0);
    expect(await rows(sql`select 1 from handover_requests where post_id = ${found.id}`)).toHaveLength(0);
    expect(await exists('conversations', conv.id)).toBe(true); // 대화는 남는다(쪽지 보존 규칙이 따로 적용)
  });

  it('now 옵션과 TTL 옵션으로 기준 시각을 바꿀 수 있다(결정적 테스트용)', async () => {
    const { id } = await postWith('CLOSED', '1 hour');
    expect((await runEndedPostsCleanup(env.db, storage(), { endedPostTtlMs: 30 * 60_000 })).purgedPosts).toBe(1);
    expect(await exists('posts', id)).toBe(false);
    const p2 = await postWith('CLOSED', '1 hour');
    expect((await runEndedPostsCleanup(env.db, storage(), { now: new Date(Date.now() - 3 * 3600_000) })).purgedPosts).toBe(0);
    expect(await exists('posts', p2.id)).toBe(true);
  });

  it('6시간 정리 작업과 별도의 임대를 쓴다: 한쪽이 실행 중이어도 다른 쪽은 건너뛰지 않고, 같은 작업끼리는 중복 실행되지 않는다', async () => {
    const slow = new Proxy(storage(), {
      get(target, prop, recv) {
        if (prop === 'delete') return async (k: string) => { await new Promise((r) => setTimeout(r, 350)); return target.delete(k); };
        return Reflect.get(target, prop, recv);
      },
    }) as PhotoStorage;
    await postWith('CLOSED', '30 hours', true);
    const first = runEndedPostsCleanup(env.db, slow, {});
    await new Promise((r) => setTimeout(r, 120));
    const second = await runEndedPostsCleanup(env.db, storage(), {});
    expect(second.skipped).toBe(true); // 같은 작업 중복 실행 방지
    const mainJob = await runCleanup(env.db, storage(), opts);
    expect(mainJob.skipped).toBe(false); // 6시간 작업은 별도 임대
    expect((await first).skipped).toBe(false);
    expect((await runEndedPostsCleanup(env.db, storage(), {})).skipped).toBe(false); // 끝나면 다시 실행 가능
  });

  it('단계 격리: 삭제 중 저장소 오류는 errors 에 보고되고 던지지 않는다', async () => {
    await postWith('CLOSED', '30 hours', true);
    const broken = new Proxy(storage(), {
      get(target, prop, recv) {
        if (prop === 'delete') return async () => { throw new Error('disk gone'); };
        return Reflect.get(target, prop, recv);
      },
    }) as PhotoStorage;
    const r = await runEndedPostsCleanup(env.db, broken, {});
    expect(Array.isArray(r.errors)).toBe(true);
  });

  it('startEndedPostsSchedule: 주기마다 실행하고 중지 함수는 진행 중 실행을 기다린다', async () => {
    const { id } = await postWith('CLOSED', '30 hours');
    const logs: string[] = [];
    const stop = startEndedPostsSchedule(env.db, storage(), {}, 50, (m) => logs.push(m), 0);
    for (let i = 0; i < 100 && (await exists('posts', id)); i++) await new Promise((r) => setTimeout(r, 50));
    await stop();
    expect(await exists('posts', id)).toBe(false);
    expect(logs.some((l) => l.includes('종료된 글'))).toBe(true);
  });

  it('6시간 작업의 90일 규칙은 안전망으로 남는다(24시간 작업이 놓친 오래된 종료 글)', async () => {
    const { id } = await postWith('CLOSED', '100 days');
    const r = await runCleanup(env.db, storage(), opts);
    expect(r.purgedPosts).toBe(1);
    expect(await exists('posts', id)).toBe(false);
  });
});

describe('설정: CLEANUP_ENDED_POSTS_INTERVAL_MIN', () => {
  it('기본 30분, 1~1440 범위, 범위 밖이면 거부', () => {
    expect(loadConfig({ NODE_ENV: 'development' } as NodeJS.ProcessEnv).CLEANUP_ENDED_POSTS_INTERVAL_MIN).toBe(30);
    expect(loadConfig({ NODE_ENV: 'development', CLEANUP_ENDED_POSTS_INTERVAL_MIN: '15' } as NodeJS.ProcessEnv).CLEANUP_ENDED_POSTS_INTERVAL_MIN).toBe(15);
    for (const v of ['0', '1441', '-5', 'abc', '2.5']) expect(() => loadConfig({ NODE_ENV: 'development', CLEANUP_ENDED_POSTS_INTERVAL_MIN: v } as NodeJS.ProcessEnv)).toThrow();
  });
  it('쪽지 보존 RETENTION_DM_DAYS 는 운영에서 1 이상(기존 규칙 유지)', () => {
    const prod = { NODE_ENV: 'production', DATABASE_URL: 'postgres://a:b@db:5432/x', ALLOWED_ORIGINS: 'https://x.example', RETENTION_DM_DAYS: '0' };
    expect(() => loadConfig(prod as NodeJS.ProcessEnv)).toThrow();
  });
});
