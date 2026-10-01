import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import { schema } from '../src/db/client.js';
import { deleteFiles, hardDeletePosts } from '../src/lib/hard-delete.js';
import { retryOnConflict } from '../src/modules/handovers/service.js';
import { LocalDiskStorage } from '../src/storage/index.js';
import { jpeg, makePost, setupEnv, signup, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => (env = await setupEnv()));
afterAll(async () => env.close());
beforeEach(async () => env.reset());

const count = async (table: string, where = 'true') => (await env.db.execute<{ c: number }>(sql.raw(`select count(*)::int as c from ${table} where ${where}`))).rows[0]!.c;
const run = (ids: number[]) => env.db.transaction((tx) => hardDeletePosts(tx, ids));

async function richPost() {
  const author = await signup(env.app);
  const other = await signup(env.app);
  const up = (await author.client.upload(await jpeg(200, 200))).body;
  const post = (await makePost(author.client, { type: 'FOUND', photoIds: [up.photoId], tags: ['학생증', '커스텀태그'] })).body;
  // 흐림 사본(학생증 태그)과 AI 사본 파일을 준비
  const row = (await env.db.execute<{ storage_key: string; blurred_key: string | null }>(sql`select storage_key, blurred_key from post_photos where id = ${up.photoId}`)).rows[0]!;
  const storage = new LocalDiskStorage(env.storageDir);
  const aiKey = 'ai/hd-test-copy.jpg';
  await storage.save(aiKey, await sharp({ create: { width: 10, height: 10, channels: 3, background: '#fff' } }).jpeg().toBuffer());
  await env.db.execute(sql`update post_photos set ai_key = ${aiKey} where id = ${up.photoId}`);
  await other.client.post(`/posts/${post.id}/comments`, { body: '댓글' });
  const lost = (await makePost(other.client, { type: 'LOST' })).body;
  const [m] = await env.db.insert(schema.matches).values({ lostPostId: lost.id, foundPostId: post.id, locationScore: 1, tagScore: 1, totalScore: 0.9, level: 'AUTO' }).returning();
  await env.db.insert(schema.notifications).values({ userId: other.user.id, type: 'MATCH', matchId: m!.id, postId: lost.id });
  await env.db.insert(schema.notifications).values({ userId: author.user.id, type: 'COMMENT', postId: post.id });
  const conv = (await other.client.post('/conversations', { postId: post.id, body: '이 글 보고 연락드려요' })).body.conversation;
  return { author, other, post, lost, up, row, aiKey, conv, storage };
}

describe('hardDeletePosts', () => {
  it('글과 연관 데이터(사진 행·댓글·태그 연결·매칭·알림·인수 요청)를 삭제하고 파일 키를 돌려준다', async () => {
    const t = await richPost();
    expect(t.row.blurred_key).toMatch(/^blurred\//);
    const res = await run([t.post.id]);
    expect(res.postIds).toEqual([t.post.id]);
    expect(res.fileKeys).toEqual(expect.arrayContaining([t.row.storage_key, t.aiKey, t.row.blurred_key!]));
    expect(await count('posts', `id = ${t.post.id}`)).toBe(0);
    expect(await count('post_photos', `post_id is null and id = ${t.up.photoId}`)).toBe(0);
    expect(await count('post_photos', `id = ${t.up.photoId}`)).toBe(0);
    expect(await count('comments', `post_id = ${t.post.id}`)).toBe(0);
    expect(await count('post_tags', `post_id = ${t.post.id}`)).toBe(0);
    expect(await count('matches', `found_post_id = ${t.post.id}`)).toBe(0);
    expect(await count('notifications', `post_id = ${t.post.id}`)).toBe(0);
    // 다른 글(분실글)과 그 알림(매칭 알림은 매칭 삭제로 cascade)은 영향 없음
    expect(await count('posts', `id = ${t.lost.id}`)).toBe(1);
    expect(await count('notifications', `type = 'MATCH'`)).toBe(0);
  });

  it('쪽지 메시지는 보존되고 글 맥락(post_id)만 null, 신고 snapshot 은 보존된다', async () => {
    const t = await richPost();
    await env.db.execute(sql`insert into reports (reporter_id, target_type, target_id, target_user_id, reason, snapshot) values (${t.other.user.id}, 'POST', ${t.post.id}, ${t.author.user.id}, 'SPAM', ${JSON.stringify({ title: '신고 시점 제목' })}::jsonb)`);
    await run([t.post.id]);
    const msgs = (await env.db.execute<{ body: string; post_id: number | null }>(sql`select body, post_id from messages`)).rows;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ body: '이 글 보고 연락드려요', post_id: null });
    expect((await env.db.execute<{ s: { title: string } }>(sql`select snapshot as s from reports`)).rows[0]!.s.title).toBe('신고 시점 제목');
    // 대화 항목의 글 맥락은 없어진다
    expect((await t.other.client.get(`/conversations/${t.conv.id}`)).body.postContext).toBeNull();
  });

  it('커밋 후 deleteFiles 로 원본·AI 사본·흐림 사본 파일이 모두 지워진다', async () => {
    const t = await richPost();
    const files = [t.row.storage_key, t.aiKey, t.row.blurred_key!].map((k) => join(env.storageDir, k));
    expect(files.every((f) => existsSync(f))).toBe(true);
    const res = await run([t.post.id]);
    expect(files.every((f) => existsSync(f))).toBe(true); // 트랜잭션 안에서는 파일을 건드리지 않는다
    expect(await deleteFiles(t.storage, res.fileKeys)).toEqual([]);
    expect(files.some((f) => existsSync(f))).toBe(false);
  });

  it('멱등: 같은 id 를 다시 호출하거나 없는 id·잘못된 값이 섞여도 오류 없이 빈 결과', async () => {
    const t = await richPost();
    expect((await run([t.post.id, t.post.id, 99999, -1, 0])).postIds).toEqual([t.post.id]);
    expect(await run([t.post.id])).toEqual({ postIds: [], fileKeys: [] });
    expect(await run([])).toEqual({ postIds: [], fileKeys: [] });
  });

  it('배치 안전: 500 건을 넘는 id 도 청크로 나눠 모두 삭제하고, 다른 글은 건드리지 않는다', async () => {
    const { client, user } = await signup(env.app);
    const keep = (await makePost(client)).body;
    const loc = (await client.get('/locations')).body.items[0].id as number;
    await env.db.execute(sql`insert into posts (type, author_id, title, description, location_id, occurred_at, match_state)
      select 'LOST', ${user.id}, 't' || g, 'd', ${loc}, now(), 'DONE' from generate_series(1, 1200) g`);
    const ids = (await env.db.execute<{ id: number }>(sql`select id from posts where title like 't%' and id <> ${keep.id}`)).rows.map((r) => r.id);
    expect(ids.length).toBe(1200);
    const res = await run(ids);
    expect(res.postIds).toHaveLength(1200);
    expect(await count('posts')).toBe(1);
    expect(await count('posts', `id = ${keep.id}`)).toBe(1);
  });

  it('인수 요청이 걸린 글도 삭제된다(인수 요청 행도 cascade)', async () => {
    const t = await richPost();
    await t.other.client.post(`/conversations/${t.conv.id}/handover`, { postId: t.post.id });
    expect(await count('handover_requests')).toBe(1);
    await run([t.post.id]);
    expect(await count('handover_requests')).toBe(0);
    expect(await count('conversations')).toBe(1); // 대화는 남는다(쪽지 보존 규칙은 별도)
  });

  it('동시성: 같은 글을 동시에 삭제하거나 인수 상태 변경과 겹쳐도 교착·오류 없이 끝난다', async () => {
    for (let i = 0; i < 4; i++) {
      const t = await richPost();
      const h = (await t.other.client.post(`/conversations/${t.conv.id}/handover`, { postId: t.post.id })).body;
      const results = await Promise.allSettled([
        retryOnConflict(() => run([t.post.id])),
        retryOnConflict(() => run([t.post.id])),
        t.author.client.post(`/handovers/${h.id}/verify`, { note: 'x' }),
        t.author.client.post(`/handovers/${h.id}/reject`),
      ]);
      expect(results.filter((r) => r.status === 'rejected'), `iteration ${i}`).toEqual([]);
      for (const r of results.slice(2)) expect((r as PromiseFulfilledResult<{ status: number }>).value.status).toBeLessThan(500);
      expect(await count('posts', `id = ${t.post.id}`)).toBe(0);
      await env.reset();
    }
  });
});
