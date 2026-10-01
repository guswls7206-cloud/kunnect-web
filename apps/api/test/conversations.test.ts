import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { setupEnv, signup, makePost, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => (env = await setupEnv()));
afterAll(async () => env.close());
beforeEach(async () => env.reset());

describe('쪽지(DM)', () => {
  it('글 상세에서 시작: 글 작성자가 상대, 첫 메시지에 글 맥락, 상대에게 알림', async () => {
    const owner = await signup(env.app);
    const asker = await signup(env.app);
    const post = (await makePost(owner.client, { type: 'FOUND' })).body;
    const r = await asker.client.post('/conversations', { postId: post.id, body: '제 물건 같아요' });
    expect(r.status).toBe(201);
    expect(r.body.conversation.other.id).toBe(owner.user.id);
    expect(r.body.conversation.postContext).toEqual({ id: post.id, title: post.title });
    expect(r.body.message.postId).toBe(post.id);
    // 상대: 쪽지함·읽지 않음·알림(본문 미리보기 없음)
    const inbox = await owner.client.get('/conversations');
    expect(inbox.body.items).toHaveLength(1);
    expect(inbox.body.items[0].unread).toBe(1);
    expect(inbox.body.items[0].lastMessage.body).toBeUndefined(); // 목록에는 본문 미노출
    const notifs = (await owner.client.get('/notifications')).body.items;
    expect(notifs[0]).toMatchObject({ type: 'MESSAGE', text: '새 쪽지가 도착했습니다.' });
    expect(notifs[0].target.kind).toBe('conversation');
    expect(JSON.stringify(notifs)).not.toContain('제 물건');
    expect((await owner.client.get('/me')).body.unread.messages).toBe(1);
  });

  it('프로필에서 시작(targetUserId), 같은 쌍은 대화 1개를 재사용(200)', async () => {
    const a = await signup(env.app);
    const b = await signup(env.app);
    const first = await a.client.post('/conversations', { targetUserId: b.user.id, body: '안녕하세요' });
    expect(first.status).toBe(201);
    const second = await b.client.post('/conversations', { targetUserId: a.user.id, body: '네 안녕하세요' });
    expect(second.status).toBe(200);
    expect(second.body.conversation.id).toBe(first.body.conversation.id);
    const count = await env.db.execute<{ c: number }>(sql`select count(*)::int as c from conversations`);
    expect(count.rows[0]!.c).toBe(1);
  });

  it('자기 자신·없는 사용자·잘못된 입력은 거부', async () => {
    const a = await signup(env.app);
    expect((await a.client.post('/conversations', { targetUserId: a.user.id, body: 'x' })).body.error.code).toBe('SELF_MESSAGE');
    const mine = (await makePost(a.client)).body;
    expect((await a.client.post('/conversations', { postId: mine.id, body: 'x' })).status).toBe(400); // 내 글에 쪽지
    expect((await a.client.post('/conversations', { targetUserId: 9999, body: 'x' })).status).toBe(404);
    expect((await a.client.post('/conversations', { body: 'x' })).status).toBe(400);
    const b = await signup(env.app);
    expect((await a.client.post('/conversations', { targetUserId: b.user.id, body: '' })).status).toBe(400);
    expect((await a.client.post('/conversations', { targetUserId: b.user.id, body: 'a'.repeat(1001) })).status).toBe(400);
  });

  it('쪽지에는 연락처 마스킹이 적용되지 않는다 (확정 17번)', async () => {
    const a = await signup(env.app);
    const b = await signup(env.app);
    const r = await a.client.post('/conversations', { targetUserId: b.user.id, body: '010-1234-5678 로 연락주세요' });
    expect(r.body.message.body).toBe('010-1234-5678 로 연락주세요');
  });

  it('메시지 주고받기 + 폴링(afterId) + 과거 조회(beforeId) + 읽음 처리(단조 증가)', async () => {
    const a = await signup(env.app);
    const b = await signup(env.app);
    const conv = (await a.client.post('/conversations', { targetUserId: b.user.id, body: 'm1' })).body.conversation;
    const ids: number[] = [];
    for (let i = 2; i <= 5; i++) ids.push((await b.client.post(`/conversations/${conv.id}/messages`, { body: `m${i}` })).body.message.id);
    const all = (await a.client.get(`/conversations/${conv.id}/messages`)).body.items;
    expect(all.map((m: { body: string }) => m.body)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    const after = (await a.client.get(`/conversations/${conv.id}/messages?afterId=${ids[1]}`)).body.items;
    expect(after.map((m: { body: string }) => m.body)).toEqual(['m4', 'm5']);
    expect((await a.client.get(`/conversations/${conv.id}/messages?afterId=${ids[3]}`)).body.items).toEqual([]);
    const before = (await a.client.get(`/conversations/${conv.id}/messages?beforeId=${ids[2]}&limit=2`)).body.items;
    expect(before.map((m: { body: string }) => m.body)).toEqual(['m2', 'm3']);
    // 읽지 않음: a 는 b 의 4건, 읽음 처리 후 0
    expect((await a.client.get('/conversations')).body.items[0].unread).toBe(4);
    expect((await a.client.post(`/conversations/${conv.id}/read`, { lastMessageId: ids[3] })).status).toBe(204);
    expect((await a.client.get('/conversations')).body.items[0].unread).toBe(0);
    // 과거 id 로 되돌려도 읽음 위치는 줄지 않는다
    await a.client.post(`/conversations/${conv.id}/read`, { lastMessageId: 1 });
    expect((await a.client.get('/conversations')).body.items[0].unread).toBe(0);
    // 읽음 처리하면 해당 대화의 쪽지 알림도 읽음
    expect((await a.client.get('/notifications/unread-count')).body.notifications).toBe(0);
  });

  it('제3자는 대화·메시지에 접근할 수 없다 (404)', async () => {
    const a = await signup(env.app);
    const b = await signup(env.app);
    const c = await signup(env.app);
    const conv = (await a.client.post('/conversations', { targetUserId: b.user.id, body: '비밀' })).body.conversation;
    expect((await c.client.get(`/conversations/${conv.id}`)).status).toBe(404);
    expect((await c.client.get(`/conversations/${conv.id}/messages`)).status).toBe(404);
    expect((await c.client.post(`/conversations/${conv.id}/messages`, { body: '끼어들기' })).status).toBe(404);
    expect((await c.client.post(`/conversations/${conv.id}/read`, { lastMessageId: 1 })).status).toBe(404);
    expect((await c.client.get('/conversations')).body.items).toEqual([]);
  });

  it('쪽지 알림은 읽기 전까지 대화당 1개만 생성(폭주 방지), 음소거 시 생성 안 함', async () => {
    const a = await signup(env.app);
    const b = await signup(env.app);
    const conv = (await a.client.post('/conversations', { targetUserId: b.user.id, body: '1' })).body.conversation;
    await a.client.post(`/conversations/${conv.id}/messages`, { body: '2' });
    await a.client.post(`/conversations/${conv.id}/messages`, { body: '3' });
    expect((await b.client.get('/notifications')).body.items).toHaveLength(1);
    await b.client.post('/notifications/read-all');
    expect((await b.client.patch(`/conversations/${conv.id}/settings`, { muted: true })).status).toBe(204);
    await a.client.post(`/conversations/${conv.id}/messages`, { body: '4' });
    expect((await b.client.get('/notifications')).body.items).toHaveLength(1); // 새 알림 없음
    expect((await b.client.get('/conversations')).body.items[0].muted).toBe(true);
  });

  it('나가기: 내 쪽지함에서 사라지고, 상대가 새 쪽지를 보내면 다시 나타난다', async () => {
    const a = await signup(env.app);
    const b = await signup(env.app);
    const conv = (await a.client.post('/conversations', { targetUserId: b.user.id, body: '1' })).body.conversation;
    expect((await b.client.post(`/conversations/${conv.id}/leave`)).status).toBe(204);
    expect((await b.client.get('/conversations')).body.items).toHaveLength(0);
    expect((await a.client.get('/conversations')).body.items).toHaveLength(1);
    await a.client.post(`/conversations/${conv.id}/messages`, { body: '2' });
    expect((await b.client.get('/conversations')).body.items).toHaveLength(1);
  });

  it('쪽지함 정렬(최근 메시지 순)과 커서 페이지네이션', async () => {
    const me = await signup(env.app);
    const others = [await signup(env.app), await signup(env.app), await signup(env.app)];
    const convs: number[] = [];
    for (const o of others) convs.push((await me.client.post('/conversations', { targetUserId: o.user.id, body: 'hi' })).body.conversation.id);
    await me.client.post(`/conversations/${convs[0]}/messages`, { body: '최신' }); // 첫 대화를 최신으로
    const p1 = (await me.client.get('/conversations?limit=2')).body;
    expect(p1.items.map((c: { id: number }) => c.id)[0]).toBe(convs[0]);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = (await me.client.get(`/conversations?limit=2&cursor=${p1.nextCursor}`)).body;
    expect(p2.items).toHaveLength(1);
    expect([...p1.items, ...p2.items].map((c: { id: number }) => c.id).sort()).toEqual([...convs].sort());
  });

  it('메시지 전송 분당 30건 초과 시 429 (레이트 리밋 활성 환경)', async () => {
    const limited = await setupEnv({ rateLimitEnabled: true });
    try {
      const a = await signup(limited.app);
      const b = await signup(limited.app);
      const conv = (await a.client.post('/conversations', { targetUserId: b.user.id, body: '0' })).body.conversation;
      let last = 0;
      for (let i = 0; i < 32; i++) last = (await a.client.post(`/conversations/${conv.id}/messages`, { body: `${i}` })).status;
      expect(last).toBe(429);
    } finally {
      await limited.reset();
      await limited.close();
    }
  });
});

describe('차단', () => {
  it('차단하면 새 쪽지·알림이 막히고, 기존 대화는 읽기 전용이며, 차단 사실은 상대 응답에 드러나지 않는다', async () => {
    const a = await signup(env.app);
    const b = await signup(env.app);
    const conv = (await a.client.post('/conversations', { targetUserId: b.user.id, body: '안녕' })).body.conversation;
    expect((await b.client.post('/blocks', { userId: a.user.id })).status).toBe(204); // b 가 a 를 차단
    // 차단당한 a: 전송 불가이지만 오류에 '차단'이라는 단어/코드가 없다
    const sent = await a.client.post(`/conversations/${conv.id}/messages`, { body: '왜 답이 없죠' });
    expect(sent.status).toBe(409);
    expect(sent.body.error.code).toBe('READ_ONLY');
    expect(JSON.stringify(sent.body)).not.toMatch(/차단|block/i);
    // 차단한 b 도 전송 불가
    expect((await b.client.post(`/conversations/${conv.id}/messages`, { body: '...' })).status).toBe(409);
    // 기존 메시지는 읽을 수 있고 readOnly 표시
    expect((await a.client.get(`/conversations/${conv.id}/messages`)).body.items).toHaveLength(1);
    expect((await a.client.get(`/conversations/${conv.id}`)).body.readOnly).toBe(true);
    // 새 대화 시작도 불가
    const c = await signup(env.app);
    await b.client.post('/blocks', { userId: c.user.id });
    expect((await c.client.post('/conversations', { targetUserId: b.user.id, body: 'x' })).status).toBe(403);
    // 알림도 생성되지 않고, 차단 전에 받은 a 의 쪽지 알림도 차단 후에는 보이지 않는다(차단 시 비노출 정책)
    expect((await b.client.get('/notifications')).body.items).toHaveLength(0);
  });

  it('차단 목록 조회·해제, 자기 차단 400, 중복 차단 멱등', async () => {
    const a = await signup(env.app);
    const b = await signup(env.app);
    expect((await a.client.post('/blocks', { userId: a.user.id })).body.error.code).toBe('SELF_BLOCK');
    expect((await a.client.post('/blocks', { userId: 9999 })).status).toBe(404);
    expect((await a.client.post('/blocks', { userId: b.user.id })).status).toBe(204);
    expect((await a.client.post('/blocks', { userId: b.user.id })).status).toBe(204);
    const list = (await a.client.get('/blocks')).body.items;
    expect(list).toHaveLength(1);
    expect(list[0].nickname).toBe(b.user.nickname);
    expect((await a.client.get(`/users/${b.user.id}`)).status).toBe(404); // 차단 시 프로필 비노출
    expect((await a.client.del(`/blocks/${b.user.id}`)).status).toBe(204);
    expect((await a.client.get('/blocks')).body.items).toHaveLength(0);
    // 해제 후 대화 가능
    expect((await a.client.post('/conversations', { targetUserId: b.user.id, body: '다시' })).status).toBe(201);
  });
});

describe('인수(Handover)', () => {
  async function scenario() {
    const finder = await signup(env.app);
    const loser = await signup(env.app);
    const found = (await makePost(finder.client, { type: 'FOUND' })).body;
    const lost = (await makePost(loser.client, { type: 'LOST' })).body;
    const conv = (await loser.client.post('/conversations', { postId: found.id, body: '제 것 같아요' })).body.conversation;
    return { finder, loser, found, lost, conv };
  }

  it('요청 → 소유 확인(습득자) → 양측 완료 → 글 RETURNED, 대화 종료, 새 댓글 비활성', async () => {
    const { finder, loser, found, lost, conv } = await scenario();
    const h = await loser.client.post(`/conversations/${conv.id}/handover`, { postId: found.id });
    expect(h.status).toBe(201);
    expect(h.body.status).toBe('REQUESTED');
    expect((await loser.client.post(`/conversations/${conv.id}/handover`, { postId: found.id })).body.error.code).toBe('ALREADY_REQUESTED');
    // 소유 확인 전 완료 불가, 분실자는 소유 확인 불가
    expect((await loser.client.post(`/handovers/${h.body.id}/complete`)).body.error.code).toBe('NOT_VERIFIED');
    expect((await loser.client.post(`/handovers/${h.body.id}/verify`, { note: '맞아요' })).status).toBe(403);
    const v = await finder.client.post(`/handovers/${h.body.id}/verify`, { note: '스티커 일치' });
    expect(v.body.status).toBe('VERIFIED');
    // 한쪽만 확인: 아직 완료 아님
    const half = await loser.client.post(`/handovers/${h.body.id}/complete`);
    expect(half.body.status).toBe('VERIFIED');
    expect((await finder.client.get(`/posts/${found.id}`)).body.status).toBe('OPEN');
    const done = await finder.client.post(`/handovers/${h.body.id}/complete`);
    expect(done.body.status).toBe('COMPLETED');
    expect((await finder.client.get(`/posts/${found.id}`)).body.status).toBe('RETURNED');
    expect((await loser.client.get(`/posts/${found.id}`)).body.status).toBe('RETURNED');
    void lost;
    const closed = await env.db.execute<{ closed_at: Date | null }>(sql`select closed_at from conversations`);
    expect(closed.rows[0]!.closed_at).toBeTruthy();
    expect((await loser.client.post(`/posts/${found.id}/comments`, { body: '감사합니다' })).status).toBe(409);
    // 시스템 메시지가 대화에 남는다
    const msgs = (await loser.client.get(`/conversations/${conv.id}/messages`)).body.items;
    expect(msgs.filter((m: { type: string }) => m.type === 'SYSTEM').length).toBeGreaterThanOrEqual(3);
  });

  it('제3자는 인수 요청에 접근할 수 없다 (404), 거절 후에는 완료 불가', async () => {
    const { finder, loser, found, conv } = await scenario();
    const outsider = await signup(env.app);
    const h = await loser.client.post(`/conversations/${conv.id}/handover`, { postId: found.id });
    expect((await outsider.client.post(`/handovers/${h.body.id}/verify`)).status).toBe(404);
    expect((await outsider.client.post(`/conversations/${conv.id}/handover`, { postId: found.id })).status).toBe(404);
    expect((await finder.client.post(`/handovers/${h.body.id}/reject`)).body.status).toBe('REJECTED');
    expect((await loser.client.post(`/handovers/${h.body.id}/complete`)).status).toBe(409);
  });
});
