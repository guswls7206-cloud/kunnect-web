import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupEnv, signup, makePost, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => (env = await setupEnv()));
afterAll(async () => env.close());
beforeEach(async () => env.reset());

async function setup() {
  const owner = await signup(env.app);
  const other = await signup(env.app);
  const post = (await makePost(owner.client)).body;
  return { owner, other, post };
}

describe('댓글', () => {
  it('작성 → 목록(오래된 순), 대댓글 1단계', async () => {
    const { owner, other, post } = await setup();
    const c1 = await other.client.post(`/posts/${post.id}/comments`, { body: '저도 봤어요' });
    expect(c1.status).toBe(201);
    expect(c1.body.masked).toBe(false);
    const reply = await owner.client.post(`/posts/${post.id}/comments`, { body: '감사합니다', parentId: c1.body.comment.id });
    expect(reply.status).toBe(201);
    expect(reply.body.comment.parentId).toBe(c1.body.comment.id);
    const list = await other.client.get(`/posts/${post.id}/comments`);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].replies).toHaveLength(1);
    expect(list.body.items[0].isMine).toBe(true);
    expect(list.body.items[0].replies[0].isMine).toBe(false);
    expect((await owner.client.get(`/posts/${post.id}`)).body.commentCount).toBe(2);
  });

  it('대댓글의 대댓글(2단계)·타 글 댓글에 대한 답글은 400 PARENT_INVALID', async () => {
    const { owner, other, post } = await setup();
    const post2 = (await makePost(owner.client)).body;
    const c1 = (await other.client.post(`/posts/${post.id}/comments`, { body: '1' })).body.comment;
    const r1 = (await other.client.post(`/posts/${post.id}/comments`, { body: '2', parentId: c1.id })).body.comment;
    const deep = await other.client.post(`/posts/${post.id}/comments`, { body: '3', parentId: r1.id });
    expect(deep.status).toBe(400);
    expect(deep.body.error.code).toBe('PARENT_INVALID');
    const cross = await other.client.post(`/posts/${post2.id}/comments`, { body: '4', parentId: c1.id });
    expect(cross.status).toBe(400);
  });

  it('연락처 패턴은 저장 전에 마스킹되고 masked=true', async () => {
    const { other, post } = await setup();
    const r = await other.client.post(`/posts/${post.id}/comments`, { body: '제꺼 같아요 010-1234-5678 / me@test.com' });
    expect(r.status).toBe(201);
    expect(r.body.masked).toBe(true);
    expect(r.body.comment.body).not.toMatch(/1234|test\.com/);
    const list = await other.client.get(`/posts/${post.id}/comments`);
    expect(list.body.items[0].body).not.toMatch(/1234|test\.com/);
    // 수정 시에도 재마스킹
    const edit = await other.client.patch(`/comments/${r.body.comment.id}`, { body: '카톡: hong123 으로' });
    expect(edit.body.masked).toBe(true);
    expect(edit.body.comment.body).not.toContain('hong123');
    expect(edit.body.comment.editedAt).toBeTruthy();
  });

  it('길이 300자 초과·빈 댓글은 400', async () => {
    const { other, post } = await setup();
    expect((await other.client.post(`/posts/${post.id}/comments`, { body: 'a'.repeat(301) })).status).toBe(400);
    expect((await other.client.post(`/posts/${post.id}/comments`, { body: '   ' })).status).toBe(400);
    expect((await other.client.post(`/posts/${post.id}/comments`, { body: 'a'.repeat(300) })).status).toBe(201);
  });

  it('본인만 수정/삭제, 답글이 있는 삭제는 자리 유지(본문 null), 없으면 완전 삭제', async () => {
    const { owner, other, post } = await setup();
    const c1 = (await other.client.post(`/posts/${post.id}/comments`, { body: '원 댓글' })).body.comment;
    await owner.client.post(`/posts/${post.id}/comments`, { body: '답글', parentId: c1.id });
    expect((await owner.client.patch(`/comments/${c1.id}`, { body: 'x' })).status).toBe(403);
    expect((await owner.client.del(`/comments/${c1.id}`)).status).toBe(403);
    expect((await other.client.del(`/comments/${c1.id}`)).status).toBe(204);
    const list = await other.client.get(`/posts/${post.id}/comments`);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].status).toBe('DELETED');
    expect(list.body.items[0].body).toBeNull();
    expect(list.body.items[0].replies).toHaveLength(1);
    expect((await other.client.patch(`/comments/${c1.id}`, { body: '부활' })).status).toBe(409);
    expect((await other.client.post(`/posts/${post.id}/comments`, { body: '답글에 답글', parentId: c1.id })).status).toBe(400);
    const c2 = (await other.client.post(`/posts/${post.id}/comments`, { body: '단독' })).body.comment;
    expect((await other.client.del(`/comments/${c2.id}`)).status).toBe(204);
    expect((await other.client.get(`/posts/${post.id}/comments`)).body.items).toHaveLength(1);
  });

  it('종료된 글(RETURNED/CLOSED)에는 새 댓글 불가 409 POST_CLOSED', async () => {
    const { owner, other, post } = await setup();
    await owner.client.post(`/posts/${post.id}/status`, { status: 'CLOSED' });
    const r = await other.client.post(`/posts/${post.id}/comments`, { body: '늦었나요' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('POST_CLOSED');
  });

  it('없는 글/댓글은 404, 내 댓글 목록', async () => {
    const { other, post } = await setup();
    expect((await other.client.get('/posts/9999/comments')).status).toBe(404);
    expect((await other.client.post('/posts/9999/comments', { body: 'x' })).status).toBe(404);
    expect((await other.client.del('/comments/9999')).status).toBe(404);
    await other.client.post(`/posts/${post.id}/comments`, { body: '내 댓글' });
    const mine = await other.client.get('/me/comments');
    expect(mine.body.items).toHaveLength(1);
    expect(mine.body.items[0].postTitle).toBe('검은색 에어팟 케이스');
  });

  it('분당 5건 초과 시 429 (레이트 리밋 활성 환경)', async () => {
    const limited = await setupEnv({ rateLimitEnabled: true });
    try {
      const { client } = await signup(limited.app);
      const post = (await makePost(client)).body;
      const codes: number[] = [];
      for (let i = 0; i < 7; i++) codes.push((await client.post(`/posts/${post.id}/comments`, { body: `c${i}` })).status);
      expect(codes.slice(0, 5).every((c) => c === 201)).toBe(true);
      expect(codes[6]).toBe(429);
    } finally {
      await limited.reset();
      await limited.close();
    }
  });
});

describe('알림', () => {
  it('댓글 → 글 작성자에게 COMMENT, 답글 → 원 댓글 작성자에게 REPLY, 본인 행위는 제외', async () => {
    const { owner, other, post } = await setup();
    await owner.client.post(`/posts/${post.id}/comments`, { body: '내 글에 내가 댓글' });
    expect((await owner.client.get('/notifications')).body.items).toHaveLength(0);
    const c = (await other.client.post(`/posts/${post.id}/comments`, { body: '댓글' })).body.comment;
    const n1 = await owner.client.get('/notifications');
    expect(n1.body.items).toHaveLength(1);
    expect(n1.body.items[0]).toMatchObject({ type: 'COMMENT', text: '내 글에 새 댓글이 달렸습니다.', readAt: null });
    expect(n1.body.items[0].target).toMatchObject({ kind: 'comment', id: c.id, postId: post.id });
    expect(n1.body.unreadCount).toBe(1);
    await owner.client.post(`/posts/${post.id}/comments`, { body: '답글', parentId: c.id });
    const n2 = await other.client.get('/notifications');
    expect(n2.body.items[0].type).toBe('REPLY');
  });

  it('알림 문구에 글 내용·위치가 포함되지 않는다', async () => {
    const { owner, other, post } = await setup();
    await other.client.post(`/posts/${post.id}/comments`, { body: '비밀 댓글 내용' });
    const text = JSON.stringify((await owner.client.get('/notifications')).body);
    expect(text).not.toContain('에어팟');
    expect(text).not.toContain('학생회관');
    expect(text).not.toContain('비밀 댓글');
  });

  it('읽음 처리·전체 읽음·unread-count, 타인 알림은 읽음 처리 불가', async () => {
    const { owner, other, post } = await setup();
    await other.client.post(`/posts/${post.id}/comments`, { body: 'a' });
    await other.client.post(`/posts/${post.id}/comments`, { body: 'b' });
    expect((await owner.client.get('/notifications/unread-count')).body).toEqual({ notifications: 2, messages: 0 });
    const list = (await owner.client.get('/notifications')).body.items;
    expect((await other.client.post(`/notifications/${list[0].id}/read`)).status).toBe(404);
    expect((await owner.client.post(`/notifications/${list[0].id}/read`)).status).toBe(204);
    expect((await owner.client.get('/notifications/unread-count')).body.notifications).toBe(1);
    expect((await owner.client.post('/notifications/read-all')).status).toBe(204);
    expect((await owner.client.get('/notifications/unread-count')).body.notifications).toBe(0);
  });

  it('알림 설정(notifyComment=false)이면 생성되지 않는다', async () => {
    const { owner, other, post } = await setup();
    await owner.client.patch('/me/settings', { notifyComment: false });
    await other.client.post(`/posts/${post.id}/comments`, { body: 'x' });
    expect((await owner.client.get('/notifications')).body.items).toHaveLength(0);
  });

  it('알림 목록 커서 페이지네이션(최신순)', async () => {
    const { owner, other, post } = await setup();
    for (let i = 0; i < 5; i++) await other.client.post(`/posts/${post.id}/comments`, { body: `c${i}` });
    const p1 = (await owner.client.get('/notifications?limit=2')).body;
    expect(p1.items).toHaveLength(2);
    const p2 = (await owner.client.get(`/notifications?limit=2&cursor=${p1.nextCursor}`)).body;
    expect(p2.items[0].id).toBeLessThan(p1.items[1].id);
  });
});
