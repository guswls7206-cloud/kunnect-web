import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import { schema } from '../src/db/client.js';
import { LocalDiskStorage } from '../src/storage/index.js';
import { jpeg, makePost, setupEnv, signup, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => (env = await setupEnv()));
afterAll(async () => env.close());
beforeEach(async () => env.reset());

const count = async (table: string, where = 'true') => (await env.db.execute<{ c: number }>(sql.raw(`select count(*)::int as c from ${table} where ${where}`))).rows[0]!.c;
const withdraw = (c: { req: (m: 'DELETE', u: string, b: unknown) => Promise<{ status: number }> }) => c.req('DELETE', '/me', { password: 'Test-Pass-77' });

describe('탈퇴 시 글·댓글 즉시 영구 삭제 [사용자 결정]', () => {
  async function setup() {
    const leaver = await signup(env.app);
    const other = await signup(env.app);
    const storage = new LocalDiskStorage(env.storageDir);
    // 진행 중 글(사진 + 민감 태그로 흐림 사본), 종료된 글, 반환 완료 글
    const up = (await leaver.client.upload(await jpeg(200, 200))).body;
    const open = (await makePost(leaver.client, { type: 'FOUND', photoIds: [up.photoId], tags: ['학생증'] })).body;
    const closed = (await makePost(leaver.client, { title: '종료될 글' })).body;
    await leaver.client.post(`/posts/${closed.id}/status`, { status: 'CLOSED' });
    const returned = (await makePost(leaver.client, { title: '반환된 글' })).body;
    await env.db.execute(sql`update posts set status = 'RETURNED', closed_at = now() where id = ${returned.id}`);
    // AI 사본
    const aiKey = 'ai/wd-copy.jpg';
    await storage.save(aiKey, await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).jpeg().toBuffer());
    await env.db.execute(sql`update post_photos set ai_key = ${aiKey} where id = ${up.photoId}`);
    // 임시 사진(글 미연결)
    const temp = (await leaver.client.upload(await jpeg(50, 50))).body;
    const rowKeys = (await env.db.execute<{ storage_key: string; blurred_key: string }>(sql`select storage_key, blurred_key from post_photos where id = ${up.photoId}`)).rows[0]!;
    return { leaver, other, open, closed, returned, up, temp, aiKey, rowKeys };
  }

  it('모든 상태의 내 글이 삭제되고 사진 원본·AI 사본·흐림 사본·임시 사진 파일도 지워진다', async () => {
    const t = await setup();
    const files = [t.rowKeys.storage_key, t.rowKeys.blurred_key, t.aiKey, t.temp.url.replace('/api/v1/files/', '')].map((k) => join(env.storageDir, k));
    expect(files.every((f) => existsSync(f))).toBe(true);
    expect((await withdraw(t.leaver.client)).status).toBe(204);
    expect(await count('posts')).toBe(0);
    expect(await count('post_photos')).toBe(0);
    expect(files.some((f) => existsSync(f))).toBe(false);
    for (const id of [t.open.id, t.closed.id, t.returned.id]) expect((await t.other.client.get(`/posts/${id}`)).status).toBe(404);
    expect((await t.other.client.get('/posts?status=RETURNED')).body.items).toEqual([]);
  });

  it('내 글에 걸린 매칭·알림·태그 연결·다른 사람의 댓글이 함께 삭제되고, 상대의 글은 남는다', async () => {
    const t = await setup();
    const lost = (await makePost(t.other.client, { type: 'LOST' })).body;
    const [m] = await env.db.insert(schema.matches).values({ lostPostId: lost.id, foundPostId: t.open.id, locationScore: 1, tagScore: 1, totalScore: 0.9, level: 'AUTO' }).returning();
    await env.db.insert(schema.notifications).values({ userId: t.other.user.id, type: 'MATCH', matchId: m!.id, postId: lost.id });
    await t.other.client.post(`/posts/${t.open.id}/comments`, { body: '당신 글에 댓글' });
    await env.db.execute(sql`insert into notifications (user_id, type, post_id) values (${t.other.user.id}, 'COMMENT', ${t.open.id})`);
    expect((await withdraw(t.leaver.client)).status).toBe(204);
    expect(await count('matches')).toBe(0);
    expect(await count('notifications', `type = 'MATCH'`)).toBe(0);
    expect(await count('notifications', `post_id = ${t.open.id}`)).toBe(0);
    expect(await count('comments')).toBe(0);
    expect(await count('post_tags', `post_id = ${t.open.id}`)).toBe(0);
    expect((await t.other.client.get(`/posts/${lost.id}`)).status).toBe(200);
    expect((await t.other.client.get(`/posts/${lost.id}/matches`)).body.items).toEqual([]);
    expect((await t.other.client.get('/notifications')).body.items).toEqual([]);
  });

  it('내 댓글(다른 사람 글에 단 것)과 내 댓글에 달린 남의 답글이 모두 삭제된다, 남의 다른 댓글은 유지', async () => {
    const leaver = await signup(env.app);
    const other = await signup(env.app);
    const third = await signup(env.app);
    const post = (await makePost(other.client)).body;
    const mine = (await leaver.client.post(`/posts/${post.id}/comments`, { body: '내 댓글' })).body.comment;
    await third.client.post(`/posts/${post.id}/comments`, { body: '내 댓글에 대한 답글', parentId: mine.id });
    await third.client.post(`/posts/${post.id}/comments`, { body: '독립 댓글' });
    await leaver.client.post(`/posts/${post.id}/comments`, { body: '내 답글', parentId: (await third.client.get(`/posts/${post.id}/comments`)).body.items.find((c: { body: string }) => c.body === '독립 댓글').id });
    expect((await withdraw(leaver.client)).status).toBe(204);
    const items = (await other.client.get(`/posts/${post.id}/comments`)).body.items;
    expect(items.map((c: { body: string }) => c.body)).toEqual(['독립 댓글']);
    expect(items[0].replies).toEqual([]);
    expect(await count('comments')).toBe(1);
  });

  it('신고 snapshot 은 보존되고, 쪽지 대화·메시지는 유지(글 맥락만 null), 상대는 읽기 전용', async () => {
    const t = await setup();
    const conv = (await t.other.client.post('/conversations', { postId: t.open.id, body: '이 글 보고 연락드립니다' })).body.conversation;
    await env.db.execute(sql`insert into reports (reporter_id, target_type, target_id, target_user_id, reason, snapshot) values (${t.other.user.id}, 'POST', ${t.open.id}, ${t.leaver.user.id}, 'SPAM', '{"title":"신고 당시"}'::jsonb)`);
    await withdraw(t.leaver.client);
    expect(await count('reports')).toBe(1);
    expect(await count('conversations')).toBe(1);
    const item = (await t.other.client.get(`/conversations/${conv.id}`)).body;
    expect(item).toMatchObject({ readOnly: true, postContext: null });
    expect((await t.other.client.get(`/conversations/${conv.id}/messages`)).body.items).toHaveLength(1);
    expect(await count('messages', 'post_id is null')).toBe(1);
  });

  it('진행 중인 인수 요청이 있어도 탈퇴는 거부되지 않고, 상대 글에 걸린 요청은 REJECTED 로 정리된다(같은 트랜잭션)', async () => {
    const leaver = await signup(env.app); // 분실자
    const finder = await signup(env.app);
    const found = (await makePost(finder.client, { type: 'FOUND' })).body;
    const conv = (await leaver.client.post('/conversations', { postId: found.id, body: '제 물건 같아요' })).body.conversation;
    const h = (await leaver.client.post(`/conversations/${conv.id}/handover`, { postId: found.id })).body;
    await finder.client.post(`/handovers/${h.id}/verify`, { note: 'ok' });
    expect((await withdraw(leaver.client)).status).toBe(204);
    expect((await env.db.execute<{ status: string }>(sql`select status from handover_requests`)).rows.map((r) => r.status)).toEqual(['REJECTED']);
    expect((await finder.client.get(`/posts/${found.id}`)).body.status).toBe('OPEN');
  });

  it('두 번 요청해도(재시도) 안전하다: 첫 요청 후 세션이 폐기되어 401', async () => {
    const t = await setup();
    expect((await withdraw(t.leaver.client)).status).toBe(204);
    expect((await withdraw(t.leaver.client)).status).toBe(401);
    expect(await count('users', `status = 'DELETED'`)).toBe(1);
  });

  it('동시에 탈퇴와 상대의 인수·댓글·쪽지가 겹쳐도 교착·500 없이 끝나고 글은 남지 않는다', async () => {
    for (let i = 0; i < 4; i++) {
      const leaver = await signup(env.app);
      const other = await signup(env.app);
      const post = (await makePost(leaver.client, { type: 'FOUND' })).body;
      const conv = (await other.client.post('/conversations', { postId: post.id, body: '문의' })).body.conversation;
      const h = (await other.client.post(`/conversations/${conv.id}/handover`, { postId: post.id })).body;
      const results = await Promise.all([
        withdraw(leaver.client),
        leaver.client.post(`/handovers/${h.id}/verify`, { note: 'x' }),
        other.client.post(`/posts/${post.id}/comments`, { body: '동시 댓글' }),
        other.client.post(`/conversations/${conv.id}/messages`, { body: '동시 쪽지' }),
        other.client.post(`/handovers/${h.id}/complete`),
      ]);
      expect(results.filter((r) => r.status >= 500), `iteration ${i}`).toEqual([]);
      expect(await count('posts', `author_id = ${leaver.user.id}`)).toBe(0);
      await env.reset();
    }
  });
});
