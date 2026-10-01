import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { setMatchHandler } from '../src/jobs/queue.js';
import { makePost, setupEnv, signup, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => (env = await setupEnv()));
afterAll(async () => env.close());
beforeEach(async () => {
  setMatchHandler(null);
  await env.reset();
});

const rows = async <T>(q: ReturnType<typeof sql>) => (await env.db.execute<T & Record<string, unknown>>(q)).rows;

/** 습득자(finder)가 FOUND 글, 주인(owner)이 LOST 글을 올리고 주인이 쪽지로 대화를 시작한 상태 */
async function scenario() {
  const finder = await signup(env.app);
  const owner = await signup(env.app);
  const found = (await makePost(finder.client, { type: 'FOUND' })).body;
  const lost = (await makePost(owner.client, { type: 'LOST' })).body;
  const conv = (await owner.client.post('/conversations', { postId: found.id, body: '제 것 같아요' })).body.conversation;
  return { finder, owner, found, lost, conv };
}

const sysMessages = (convId: number, like: string) =>
  rows<{ id: number }>(sql`select id from messages where conversation_id = ${convId} and type = 'SYSTEM' and body like ${like}`);

describe('인수 상태 전이 원자성', () => {
  it('verify 와 reject 가 동시에 와도 응답과 최종 상태가 일치한다(거절이 성공 응답이면 최종은 REJECTED)', async () => {
    for (let i = 0; i < 12; i++) {
      const { finder, owner, found, conv } = await scenario();
      const h = (await owner.client.post(`/conversations/${conv.id}/handover`, { postId: found.id })).body;
      const [v, r] = await Promise.all([finder.client.post(`/handovers/${h.id}/verify`, {}), finder.client.post(`/handovers/${h.id}/reject`)]);
      const [row] = await rows<{ status: string }>(sql`select status from handover_requests where id = ${h.id}`);
      expect([200, 409]).toContain(v.status);
      expect([200, 409]).toContain(r.status);
      // reject 는 REQUESTED/VERIFIED 어디서든 가능하므로 reject 가 성공했다면 결과는 항상 REJECTED 여야 한다
      if (r.status === 200) expect(row!.status).toBe('REJECTED');
      // reject 가 실패했다면 verify 가 이긴 것이므로 VERIFIED
      else expect(row!.status).toBe('VERIFIED');
      await env.reset();
    }
  });

  it('같은 사용자의 complete 더블클릭은 멱등: 확인 메시지는 1개, 두 번째도 200', async () => {
    const { finder, owner, found, conv } = await scenario();
    const h = (await owner.client.post(`/conversations/${conv.id}/handover`, { postId: found.id })).body;
    await finder.client.post(`/handovers/${h.id}/verify`, {});
    const rs = await Promise.all([owner.client.post(`/handovers/${h.id}/complete`), owner.client.post(`/handovers/${h.id}/complete`)]);
    expect(rs.map((r) => r.status)).toEqual([200, 200]);
    expect(await sysMessages(conv.id, '인수 완료를 확인했습니다%')).toHaveLength(1);
    const [row] = await rows<{ status: string }>(sql`select status from handover_requests where id = ${h.id}`);
    expect(row!.status).toBe('VERIFIED'); // 상대 확인 전이므로 아직 완료 아님
  });

  it('양쪽이 동시에 complete 해도 "인수가 완료되었습니다"는 정확히 1번, 최종 COMPLETED', async () => {
    for (let i = 0; i < 8; i++) {
      const { finder, owner, found, conv } = await scenario();
      const h = (await owner.client.post(`/conversations/${conv.id}/handover`, { postId: found.id })).body;
      await finder.client.post(`/handovers/${h.id}/verify`, {});
      const rs = await Promise.all([owner.client.post(`/handovers/${h.id}/complete`), finder.client.post(`/handovers/${h.id}/complete`)]);
      expect(rs.every((r) => r.status === 200)).toBe(true);
      const [row] = await rows<{ status: string }>(sql`select status from handover_requests where id = ${h.id}`);
      expect(row!.status).toBe('COMPLETED');
      expect(await sysMessages(conv.id, '인수가 완료되었습니다%')).toHaveLength(1);
      await env.reset();
    }
  });

  it('완료된 인수에 대한 verify/reject/complete 는 409(상태 되돌림 불가), 응답 본문은 현재 상태', async () => {
    const { finder, owner, found, conv } = await scenario();
    const h = (await owner.client.post(`/conversations/${conv.id}/handover`, { postId: found.id })).body;
    await finder.client.post(`/handovers/${h.id}/verify`, {});
    await owner.client.post(`/handovers/${h.id}/complete`);
    await finder.client.post(`/handovers/${h.id}/complete`);
    expect((await finder.client.post(`/handovers/${h.id}/reject`)).status).toBe(409);
    expect((await finder.client.post(`/handovers/${h.id}/verify`, {})).status).toBe(409);
    // 완료 후 complete 재호출은 멱등(이미 완료) — 메시지가 늘지 않는다
    const again = await owner.client.post(`/handovers/${h.id}/complete`);
    expect([200, 409]).toContain(again.status);
    expect(await sysMessages(conv.id, '인수가 완료되었습니다%')).toHaveLength(1);
  });

  it('complete 시 글이 이미 종료됐으면 409 POST_CLOSED, 인수는 완료되지 않고 취소(REJECTED)된다', async () => {
    const { finder, owner, found, conv } = await scenario();
    const h = (await owner.client.post(`/conversations/${conv.id}/handover`, { postId: found.id })).body;
    await finder.client.post(`/handovers/${h.id}/verify`, {});
    expect((await finder.client.post(`/posts/${found.id}/status`, { status: 'CLOSED' })).status).toBe(200);
    const r = await owner.client.post(`/handovers/${h.id}/complete`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('POST_CLOSED');
    const [row] = await rows<{ status: string }>(sql`select status from handover_requests where id = ${h.id}`);
    expect(row!.status).toBe('REJECTED');
    const [c] = await rows<{ closed_at: Date | null }>(sql`select closed_at from conversations where id = ${conv.id}`);
    expect(c!.closed_at).toBeNull();
    expect(await sysMessages(conv.id, '인수가 완료되었습니다%')).toHaveLength(0);
  });

  it('글이 종료된 뒤에는 verify 도 409 POST_CLOSED', async () => {
    const { finder, owner, found, conv } = await scenario();
    const h = (await owner.client.post(`/conversations/${conv.id}/handover`, { postId: found.id })).body;
    await finder.client.post(`/posts/${found.id}/status`, { status: 'CLOSED' });
    const r = await finder.client.post(`/handovers/${h.id}/verify`, {});
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('POST_CLOSED');
  });
});

describe('대화 종료(closedAt) 규칙 [가정/제안] — 쌍 대화는 재사용되므로 읽기 전용으로 만들지 않는다', () => {
  async function complete(finder: Awaited<ReturnType<typeof signup>>, owner: Awaited<ReturnType<typeof signup>>, convId: number, postId: number) {
    const h = (await owner.client.post(`/conversations/${convId}/handover`, { postId })).body;
    await finder.client.post(`/handovers/${h.id}/verify`, {});
    await owner.client.post(`/handovers/${h.id}/complete`);
    await finder.client.post(`/handovers/${h.id}/complete`);
    return h.id as number;
  }

  it('인수 완료 후에도 대화는 쓰기 가능(readOnly=false)하고, closedAt 은 보존 시계로 최초 1회만 설정된다', async () => {
    const { finder, owner, found, conv } = await scenario();
    await complete(finder, owner, conv.id, found.id);
    const [c1] = await rows<{ closed_at: Date }>(sql`select closed_at from conversations where id = ${conv.id}`);
    expect(c1!.closed_at).toBeTruthy();
    expect((await owner.client.get(`/conversations/${conv.id}`)).body.readOnly).toBe(false);
    expect((await owner.client.post(`/conversations/${conv.id}/messages`, { body: '감사합니다' })).status).toBe(201);
    // 같은 대화로 다른 물건을 또 인수 → closedAt 이 뒤로 밀리지 않는다(삭제 시점 연장 방지)
    const found2 = (await makePost(finder.client, { type: 'FOUND' })).body;
    await complete(finder, owner, conv.id, found2.id);
    const [c2] = await rows<{ closed_at: Date }>(sql`select closed_at from conversations where id = ${conv.id}`);
    expect(new Date(c2!.closed_at).getTime()).toBe(new Date(c1!.closed_at).getTime());
  });

  it('이미 인수 완료(RETURNED)된 글에는 새 인수를 시작할 수 없다(409 POST_CLOSED)', async () => {
    const { finder, owner, found, conv } = await scenario();
    await complete(finder, owner, conv.id, found.id);
    const r = await owner.client.post(`/conversations/${conv.id}/handover`, { postId: found.id });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('POST_CLOSED');
  });

  it('한 대화에서 진행 중인 인수는 1건뿐(다른 글이어도 409 ALREADY_REQUESTED), 거절 후에는 다시 시작 가능', async () => {
    const { finder, owner, found, conv } = await scenario();
    const found2 = (await makePost(finder.client, { type: 'FOUND' })).body;
    const h = (await owner.client.post(`/conversations/${conv.id}/handover`, { postId: found.id })).body;
    const dup = await owner.client.post(`/conversations/${conv.id}/handover`, { postId: found2.id });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('ALREADY_REQUESTED');
    await finder.client.post(`/handovers/${h.id}/reject`);
    expect((await owner.client.post(`/conversations/${conv.id}/handover`, { postId: found2.id })).status).toBe(201);
  });

  it('동시에 인수 시작을 눌러도 진행 중 요청은 1건만 생긴다', async () => {
    const { finder, owner, found, conv } = await scenario();
    const found2 = (await makePost(finder.client, { type: 'FOUND' })).body;
    const rs = await Promise.all([
      owner.client.post(`/conversations/${conv.id}/handover`, { postId: found.id }),
      owner.client.post(`/conversations/${conv.id}/handover`, { postId: found2.id }),
      owner.client.post(`/conversations/${conv.id}/handover`, { postId: found.id }),
    ]);
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    const [c] = await rows<{ c: number }>(sql`select count(*)::int as c from handover_requests where conversation_id = ${conv.id} and status in ('REQUESTED','VERIFIED')`);
    expect(c!.c).toBe(1);
  });

  it('대화당 인수 요청 총 10건 상한(거절 반복 방지) → 409 HANDOVER_LIMIT', async () => {
    const { finder, owner, found, conv } = await scenario();
    for (let i = 0; i < 10; i++) {
      const h = await owner.client.post(`/conversations/${conv.id}/handover`, { postId: found.id });
      expect(h.status).toBe(201);
      await finder.client.post(`/handovers/${h.body.id}/reject`);
    }
    const r = await owner.client.post(`/conversations/${conv.id}/handover`, { postId: found.id });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('HANDOVER_LIMIT');
  });

  it('탈퇴한 상대와의 대화는 여전히 읽기 전용(closedAt 이 아니라 사용자 상태로 판단)', async () => {
    const { finder, owner, conv } = await scenario();
    await owner.client.req('DELETE', '/me', { password: 'Test-Pass-77' });
    expect((await finder.client.get(`/conversations/${conv.id}`)).body.readOnly).toBe(true);
    expect((await finder.client.post(`/conversations/${conv.id}/messages`, { body: 'x' })).status).toBe(409);
  });
});

describe('신고 대상 검증', () => {
  it('자기 자신(글/댓글/쪽지/사용자)은 신고할 수 없다 → 400 SELF_REPORT', async () => {
    const a = await signup(env.app);
    const b = await signup(env.app);
    const post = (await makePost(a.client)).body;
    const comment = (await a.client.post(`/posts/${post.id}/comments`, { body: '내 댓글' })).body.comment;
    const conv = (await a.client.post('/conversations', { targetUserId: b.user.id, body: '내 쪽지' })).body;
    for (const t of [
      { targetType: 'POST', targetId: post.id },
      { targetType: 'COMMENT', targetId: comment.id },
      { targetType: 'MESSAGE', targetId: conv.message.id },
      { targetType: 'USER', targetId: a.user.id },
    ]) {
      const r = await a.client.post('/reports', { ...t, reason: 'SPAM' });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('SELF_REPORT');
    }
    expect(await rows(sql`select 1 from reports`)).toHaveLength(0);
  });

  it('숨김/삭제된 댓글은 신고할 수 없다(404)', async () => {
    const a = await signup(env.app);
    const b = await signup(env.app);
    const post = (await makePost(a.client)).body;
    const hidden = (await b.client.post(`/posts/${post.id}/comments`, { body: '숨겨질 댓글' })).body.comment;
    const deleted = (await b.client.post(`/posts/${post.id}/comments`, { body: '삭제될 댓글' })).body.comment;
    await env.db.execute(sql`update comments set status = 'HIDDEN' where id = ${hidden.id}`);
    expect((await b.client.del(`/comments/${deleted.id}`)).status).toBe(204);
    for (const id of [hidden.id, deleted.id]) {
      expect((await a.client.post('/reports', { targetType: 'COMMENT', targetId: id, reason: 'SPAM' })).status).toBe(404);
    }
    expect(await rows(sql`select 1 from reports`)).toHaveLength(0);
  });

  it('탈퇴한 사용자(와 그 글)는 신고할 수 없다(404)', async () => {
    const a = await signup(env.app);
    const b = await signup(env.app);
    const post = (await makePost(b.client)).body;
    await b.client.req('DELETE', '/me', { password: 'Test-Pass-77' });
    expect((await a.client.post('/reports', { targetType: 'USER', targetId: b.user.id, reason: 'FAKE' })).status).toBe(404);
    expect((await a.client.post('/reports', { targetType: 'POST', targetId: post.id, reason: 'FAKE' })).status).toBe(404);
  });

  it('정상 대상은 여전히 신고 가능(회귀)', async () => {
    const a = await signup(env.app);
    const b = await signup(env.app);
    const post = (await makePost(a.client)).body;
    expect((await b.client.post('/reports', { targetType: 'POST', targetId: post.id, reason: 'SPAM' })).status).toBe(201);
  });
});
