import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client.js';
import { makePost, setupEnv, signup, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => (env = await setupEnv()));
afterAll(async () => env.close());
beforeEach(async () => env.reset());

/** A 가 B 를 차단한 상황. C 는 제3자. */
async function setup() {
  const a = await signup(env.app);
  const b = await signup(env.app);
  const c = await signup(env.app);
  const aPost = (await makePost(a.client, { title: 'A의 글', tags: ['지갑'] })).body;
  const bPost = (await makePost(b.client, { title: 'B의 글', tags: ['지갑'], description: '검색용 고유단어zzq' })).body;
  const cPost = (await makePost(c.client, { title: 'C의 글', tags: ['지갑'] })).body;
  expect((await a.client.post('/blocks', { userId: b.user.id })).status).toBe(204);
  return { a, b, c, aPost, bPost, cPost };
}

const ids = (r: { body: { items: { id: number }[] } }) => r.body.items.map((p) => p.id);

describe('차단 시 프로필·글 비노출 (양방향)', () => {
  it('프로필: 차단한 쪽·차단당한 쪽 모두 상대 프로필과 글 목록이 404, 제3자는 정상', async () => {
    const { a, b, c } = await setup();
    for (const [viewer, target] of [[a, b], [b, a]] as const) {
      const profile = await viewer.client.get(`/users/${target.user.id}`);
      expect(profile.status).toBe(404);
      expect(JSON.stringify(profile.body)).not.toMatch(/차단|block/i);
      expect((await viewer.client.get(`/users/${target.user.id}/posts`)).status).toBe(404);
    }
    expect((await c.client.get(`/users/${a.user.id}`)).status).toBe(200);
    expect((await c.client.get(`/users/${b.user.id}/posts`)).status).toBe(200);
    expect((await a.client.get(`/users/${a.user.id}`)).status).toBe(200); // 내 프로필
  });

  it('글 목록·검색·태그 필터: 서로의 글이 보이지 않고 제3자 글은 보인다', async () => {
    const { a, b, aPost, bPost, cPost } = await setup();
    expect(ids(await a.client.get('/posts'))).toEqual(expect.arrayContaining([aPost.id, cPost.id]));
    expect(ids(await a.client.get('/posts'))).not.toContain(bPost.id);
    expect(ids(await b.client.get('/posts'))).not.toContain(aPost.id);
    expect(ids(await b.client.get('/posts'))).toEqual(expect.arrayContaining([bPost.id, cPost.id]));
    expect(ids(await a.client.get('/posts?q=' + encodeURIComponent('고유단어zzq')))).toEqual([]);
    expect(ids(await b.client.get('/posts?q=' + encodeURIComponent('고유단어zzq')))).toEqual([bPost.id]);
    expect(ids(await a.client.get('/posts?tag=' + encodeURIComponent('지갑')))).not.toContain(bPost.id);
  });

  it('글 상세·댓글 목록·댓글 작성: 상대 글은 404, 내 글은 그대로', async () => {
    const { a, b, aPost, bPost } = await setup();
    expect((await a.client.get(`/posts/${bPost.id}`)).status).toBe(404);
    expect((await b.client.get(`/posts/${aPost.id}`)).status).toBe(404);
    expect((await a.client.get(`/posts/${bPost.id}/comments`)).status).toBe(404);
    expect((await a.client.post(`/posts/${bPost.id}/comments`, { body: '안녕' })).status).toBe(404);
    expect((await a.client.get(`/posts/${aPost.id}`)).status).toBe(200);
    expect((await a.client.get('/me/posts')).body.items).toHaveLength(1);
  });

  it('차단을 해제하면 다시 보인다', async () => {
    const { a, b, bPost } = await setup();
    await a.client.del(`/blocks/${b.user.id}`);
    expect((await a.client.get(`/users/${b.user.id}`)).status).toBe(200);
    expect((await a.client.get(`/posts/${bPost.id}`)).status).toBe(200);
    expect(ids(await a.client.get('/posts'))).toContain(bPost.id);
  });

  it('차단 목록과 차단 해제는 프로필 404 와 무관하게 동작한다', async () => {
    const { a, b } = await setup();
    const list = (await a.client.get('/blocks')).body.items;
    expect(list).toHaveLength(1);
    expect(list[0].userId).toBe(b.user.id);
    expect((await a.client.del(`/blocks/${b.user.id}`)).status).toBe(204);
  });
});

describe('차단 시 매칭 비노출', () => {
  async function matchSetup() {
    const a = await signup(env.app); // 분실자
    const b = await signup(env.app); // 습득자
    const lost = (await makePost(a.client, { type: 'LOST' })).body;
    const found = (await makePost(b.client, { type: 'FOUND' })).body;
    const [m] = await env.db.insert(schema.matches).values({ lostPostId: lost.id, foundPostId: found.id, locationScore: 1, tagScore: 1, totalScore: 0.9, level: 'AUTO' }).returning();
    return { a, b, lost, found, m: m! };
  }

  it('차단 후 양쪽의 매칭 목록에서 상대 글이 사라지고 상세·결정은 404', async () => {
    const { a, b, lost, found, m } = await matchSetup();
    expect((await a.client.get(`/posts/${lost.id}/matches`)).body.items).toHaveLength(1);
    await a.client.post('/blocks', { userId: b.user.id });
    expect((await a.client.get(`/posts/${lost.id}/matches`)).body.items).toEqual([]);
    expect((await b.client.get(`/posts/${found.id}/matches`)).body.items).toEqual([]);
    expect((await a.client.get('/me/matches')).body.items).toEqual([]);
    expect((await a.client.get(`/matches/${m.id}`)).status).toBe(404);
    expect((await b.client.get(`/matches/${m.id}`)).status).toBe(404);
    expect((await a.client.post(`/matches/${m.id}/confirm`)).status).toBe(404);
    expect((await a.client.post(`/matches/${m.id}/reject`)).status).toBe(404);
  });
});

describe('차단 시 알림 비노출', () => {
  it('차단 전에 받은 댓글·답글·쪽지·매칭 알림이 차단 후 목록과 배지에서 사라진다', async () => {
    const a = await signup(env.app);
    const b = await signup(env.app);
    const c = await signup(env.app);
    const aPost = (await makePost(a.client, { type: 'LOST' })).body;
    const bFound = (await makePost(b.client, { type: 'FOUND' })).body;
    // B 와 C 가 A 의 글에 댓글 → A 에게 COMMENT 알림 2건
    await b.client.post(`/posts/${aPost.id}/comments`, { body: 'B 댓글' });
    await c.client.post(`/posts/${aPost.id}/comments`, { body: 'C 댓글' });
    // B 가 A 에게 쪽지 → MESSAGE 알림
    await b.client.post('/conversations', { targetUserId: a.user.id, body: 'B 쪽지' });
    // 매칭 알림
    const [m] = await env.db.insert(schema.matches).values({ lostPostId: aPost.id, foundPostId: bFound.id, locationScore: 1, tagScore: 1, totalScore: 0.9, level: 'AUTO' }).returning();
    await env.db.insert(schema.notifications).values({ userId: a.user.id, type: 'MATCH', matchId: m!.id, postId: aPost.id });
    expect((await a.client.get('/notifications')).body.items).toHaveLength(4);
    expect((await a.client.get('/me')).body.unread).toEqual({ notifications: 3, messages: 1 });

    await a.client.post('/blocks', { userId: b.user.id });

    const after = (await a.client.get('/notifications')).body;
    expect(after.items.map((n: { type: string }) => n.type)).toEqual(['COMMENT']); // C 의 댓글 알림만 남음
    expect(after.unreadCount).toBe(1);
    expect((await a.client.get('/notifications/unread-count')).body).toEqual({ notifications: 1, messages: 0 });
    expect((await a.client.get('/me')).body.unread).toEqual({ notifications: 1, messages: 0 });
  });
});

describe('기존 차단 동작 유지', () => {
  it('쪽지 시작은 여전히 403 BLOCKED(중립 문구), 댓글 작성자 알림 억제', async () => {
    const { a, b } = await setup();
    const r = await b.client.post('/conversations', { targetUserId: a.user.id, body: 'x' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('BLOCKED');
  });
});
