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

describe('DELETE /posts/{id} = 즉시 영구 삭제 [A32]', () => {
  it.each(['OPEN', 'MATCHED', 'CLOSED', 'RETURNED'])('%s 상태의 내 글도 204 로 삭제되고 상세·내 글 목록·목록·검색에서 사라진다', async (status) => {
    const { client, user } = await signup(env.app);
    const other = await signup(env.app);
    const post = (await makePost(client, { title: `삭제대상${status}` })).body;
    await env.db.execute(sql`update posts set status = ${status}, closed_at = ${status === 'CLOSED' || status === 'RETURNED' ? new Date() : null} where id = ${post.id}`);
    expect((await client.del(`/posts/${post.id}`)).status).toBe(204);
    expect(await count('posts', `id = ${post.id}`)).toBe(0);
    expect((await client.get(`/posts/${post.id}`)).status).toBe(404);
    expect((await client.get('/me/posts')).body.items).toEqual([]);
    expect((await client.get(`/me/posts?status=${status}`)).body.items).toEqual([]);
    expect((await other.client.get('/posts?q=' + encodeURIComponent(`삭제대상${status}`))).body.items).toEqual([]);
    expect((await other.client.get(`/users/${user.id}/posts`)).body.items).toEqual([]);
  });

  it('이미 삭제된 글을 다시 삭제하면 404, 없는 글도 404, 다른 사람의 글은 403 이고 글은 그대로', async () => {
    const owner = await signup(env.app);
    const other = await signup(env.app);
    const post = (await makePost(owner.client)).body;
    const r = await other.client.del(`/posts/${post.id}`);
    expect(r.status).toBe(403);
    expect(await count('posts', `id = ${post.id}`)).toBe(1);
    expect((await owner.client.del(`/posts/${post.id}`)).status).toBe(204);
    const again = await owner.client.del(`/posts/${post.id}`);
    expect(again.status).toBe(404);
    expect(again.body.error.code).toBe('NOT_FOUND');
    expect((await owner.client.del('/posts/99999')).status).toBe(404);
  });

  it('연관 데이터(사진 행·파일(원본/AI/흐림)·댓글·태그·매칭·알림)가 삭제되고, 쪽지 메시지는 글 맥락만 사라지며 신고 snapshot 은 보존된다', async () => {
    const owner = await signup(env.app);
    const other = await signup(env.app);
    const storage = new LocalDiskStorage(env.storageDir);
    const up = (await owner.client.upload(await jpeg(200, 200))).body;
    const post = (await makePost(owner.client, { type: 'FOUND', photoIds: [up.photoId], tags: ['학생증'] })).body;
    const row = (await env.db.execute<{ storage_key: string; blurred_key: string }>(sql`select storage_key, blurred_key from post_photos where id = ${up.photoId}`)).rows[0]!;
    const aiKey = 'ai/pd-copy.jpg';
    await storage.save(aiKey, await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).jpeg().toBuffer());
    await env.db.execute(sql`update post_photos set ai_key = ${aiKey} where id = ${up.photoId}`);
    await other.client.post(`/posts/${post.id}/comments`, { body: '댓글' });
    const lost = (await makePost(other.client, { type: 'LOST' })).body;
    const [m] = await env.db.insert(schema.matches).values({ lostPostId: lost.id, foundPostId: post.id, locationScore: 1, tagScore: 1, totalScore: 0.9, level: 'AUTO' }).returning();
    await env.db.insert(schema.notifications).values({ userId: other.user.id, type: 'MATCH', matchId: m!.id, postId: lost.id });
    const conv = (await other.client.post('/conversations', { postId: post.id, body: '이 글 보고 연락드려요' })).body.conversation;
    await env.db.execute(sql`insert into reports (reporter_id, target_type, target_id, target_user_id, reason, snapshot) values (${other.user.id}, 'POST', ${post.id}, ${owner.user.id}, 'SPAM', '{"title":"신고 당시"}'::jsonb)`);
    const files = [row.storage_key, row.blurred_key, aiKey].map((k) => join(env.storageDir, k));
    expect(files.every((f) => existsSync(f))).toBe(true);

    expect((await owner.client.del(`/posts/${post.id}`)).status).toBe(204);

    expect(files.some((f) => existsSync(f))).toBe(false);
    expect(await count('post_photos')).toBe(0);
    expect(await count('comments')).toBe(0);
    expect(await count('post_tags', `post_id = ${post.id}`)).toBe(0);
    expect(await count('matches')).toBe(0);
    expect(await count('notifications', `type = 'MATCH'`)).toBe(0);
    expect(await count('reports')).toBe(1);
    expect(await count('messages', 'post_id is null')).toBe(1);
    expect((await other.client.get(`/conversations/${conv.id}`)).body.postContext).toBeNull();
    expect((await other.client.get(`/posts/${lost.id}`)).status).toBe(200); // 상대 글은 영향 없음
  });

  it('진행 중인 인수 요청(REQUESTED/VERIFIED)이 있으면 409 ACTIVE_HANDOVER 이고 글은 그대로, 거절 후에는 삭제된다', async () => {
    const finder = await signup(env.app);
    const owner = await signup(env.app);
    const found = (await makePost(finder.client, { type: 'FOUND' })).body;
    const conv = (await owner.client.post('/conversations', { postId: found.id, body: '제 것 같아요' })).body.conversation;
    const h = (await owner.client.post(`/conversations/${conv.id}/handover`, { postId: found.id })).body;
    const r = await finder.client.del(`/posts/${found.id}`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('ACTIVE_HANDOVER');
    await finder.client.post(`/handovers/${h.id}/verify`, { note: 'ok' });
    expect((await finder.client.del(`/posts/${found.id}`)).status).toBe(409); // VERIFIED 도 마찬가지
    expect(await count('posts', `id = ${found.id}`)).toBe(1);
    await finder.client.post(`/handovers/${h.id}/reject`);
    expect((await finder.client.del(`/posts/${found.id}`)).status).toBe(204);
    expect(await count('handover_requests')).toBe(0); // 거절된 기록도 글과 함께 삭제
  });

  it('인수가 완료되어 RETURNED 가 된 글도 삭제할 수 있다', async () => {
    const finder = await signup(env.app);
    const owner = await signup(env.app);
    const found = (await makePost(finder.client, { type: 'FOUND' })).body;
    const conv = (await owner.client.post('/conversations', { postId: found.id, body: '제 것 같아요' })).body.conversation;
    const h = (await owner.client.post(`/conversations/${conv.id}/handover`, { postId: found.id })).body;
    await finder.client.post(`/handovers/${h.id}/verify`, {});
    await owner.client.post(`/handovers/${h.id}/complete`);
    await finder.client.post(`/handovers/${h.id}/complete`);
    expect((await finder.client.get(`/posts/${found.id}`)).body.status).toBe('RETURNED');
    expect((await finder.client.del(`/posts/${found.id}`)).status).toBe(204);
    expect((await finder.client.get('/me/posts')).body.items).toEqual([]);
  });

  it('조용히 닫기(POST /posts/{id}/status CLOSED)는 그대로 소프트 종료: 작성자에게는 남고 다른 사용자에게는 404', async () => {
    const owner = await signup(env.app);
    const other = await signup(env.app);
    const post = (await makePost(owner.client)).body;
    expect((await owner.client.post(`/posts/${post.id}/status`, { status: 'CLOSED' })).status).toBe(200);
    expect((await owner.client.get('/me/posts?status=CLOSED')).body.items).toHaveLength(1);
    expect((await owner.client.get(`/posts/${post.id}`)).body.status).toBe('CLOSED');
    expect((await other.client.get(`/posts/${post.id}`)).status).toBe(404);
    expect(await count('posts', `id = ${post.id}`)).toBe(1);
  });
});

describe('DELETE /posts/{id} 동시성', () => {
  it('같은 글을 동시에 두 번 삭제하면 하나만 204, 나머지는 404 (500 없음)', async () => {
    for (let i = 0; i < 4; i++) {
      const { client } = await signup(env.app);
      const post = (await makePost(client)).body;
      const res = await Promise.all([client.del(`/posts/${post.id}`), client.del(`/posts/${post.id}`)]);
      expect(res.map((r) => r.status).sort(), `iteration ${i}`).toEqual([204, 404]);
      await env.reset();
    }
  });

  it('삭제와 댓글·쪽지 시작·매칭 결정·인수 요청이 겹쳐도 500 없이 끝나고 글은 남지 않는다', async () => {
    for (let i = 0; i < 8; i++) {
      const finder = await signup(env.app);
      const other = await signup(env.app);
      const found = (await makePost(finder.client, { type: 'FOUND' })).body;
      const lost = (await makePost(other.client, { type: 'LOST' })).body;
      const [m] = await env.db.insert(schema.matches).values({ lostPostId: lost.id, foundPostId: found.id, locationScore: 1, tagScore: 1, totalScore: 0.9, level: 'AUTO' }).returning();
      const conv = (await other.client.post('/conversations', { postId: found.id, body: '문의' })).body.conversation;
      const results = await Promise.all([
        finder.client.del(`/posts/${found.id}`),
        other.client.post(`/posts/${found.id}/comments`, { body: '동시 댓글' }),
        other.client.post(`/matches/${m!.id}/confirm`),
        other.client.post(`/conversations/${conv.id}/handover`, { postId: found.id }),
        other.client.post(`/conversations/${conv.id}/messages`, { body: '동시 쪽지', postId: found.id }),
      ]);
      expect(results.filter((r) => r.status >= 500), `iteration ${i}`).toEqual([]);
      // 삭제가 인수 요청보다 먼저면 204, 인수 요청이 먼저 생기면 409(ACTIVE_HANDOVER) 둘 다 정상
      expect([204, 409]).toContain(results[0]!.status);
      if (results[0]!.status === 204) expect(await count('posts', `id = ${found.id}`)).toBe(0);
      await env.reset();
    }
  });
});
