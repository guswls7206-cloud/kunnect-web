import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { makePost, setupEnv, signup, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => (env = await setupEnv()));
afterAll(async () => env.close());
beforeEach(async () => env.reset());

async function scenario() {
  const finder = await signup(env.app);
  const owner = await signup(env.app);
  const found = (await makePost(finder.client, { type: 'FOUND' })).body;
  const conv = (await owner.client.post('/conversations', { postId: found.id, body: '제 것 같아요' })).body.conversation;
  return { finder, owner, found, conv };
}

describe('인수 요청 DB 제약', () => {
  it('대화당 진행 중(REQUESTED/VERIFIED) 인수 요청은 DB 수준에서도 1개만 허용된다', async () => {
    const { owner, found, conv } = await scenario();
    await owner.client.post(`/conversations/${conv.id}/handover`, { postId: found.id });
    await expect(
      env.db.execute(sql`insert into handover_requests (post_id, conversation_id, requester_id, status) values (${found.id}, ${conv.id}, ${owner.user.id}, 'VERIFIED')`),
    ).rejects.toThrow();
    // 종료된 요청은 여러 개 있을 수 있다
    await env.db.execute(sql`update handover_requests set status = 'REJECTED'`);
    await env.db.execute(sql`insert into handover_requests (post_id, conversation_id, requester_id, status) values (${found.id}, ${conv.id}, ${owner.user.id}, 'REQUESTED')`);
  });

  it('계정 삭제 시 상대 글에 걸린 진행 중 인수 요청은 같은 트랜잭션에서 REJECTED 로 정리되고 대화(종료 시각 포함)는 건드리지 않는다', async () => {
    const { finder, owner, found, conv } = await scenario();
    await owner.client.post(`/conversations/${conv.id}/handover`, { postId: found.id });
    await env.db.execute(sql`update conversations set closed_at = now() - interval '5 days'`);
    // owner(요청자, 분실자)가 탈퇴: 습득자의 글(found)은 남고 인수 요청만 REJECTED
    expect((await owner.client.req('DELETE', '/me', { password: 'Test-Pass-77' })).status).toBe(204);
    const h = await env.db.execute<{ status: string }>(sql`select status from handover_requests`);
    expect(h.rows.map((r) => r.status)).toEqual(['REJECTED']);
    expect((await finder.client.get(`/posts/${found.id}`)).status).toBe(200); // 상대 글은 영향 없음
    const c = await env.db.execute<{ days: number }>(sql`select extract(epoch from (now() - closed_at)) / 86400 as days from conversations`);
    expect(Number(c.rows[0]!.days)).toBeGreaterThan(4.9); // 종료 시각을 다시 쓰지 않는다
  });

  it('자기 글에 걸린 인수 요청은 글과 함께 삭제되고(cascade) 탈퇴는 거부되지 않는다', async () => {
    const { finder, owner, found, conv } = await scenario();
    await owner.client.post(`/conversations/${conv.id}/handover`, { postId: found.id });
    expect((await finder.client.req('DELETE', '/me', { password: 'Test-Pass-77' })).status).toBe(204);
    expect((await env.db.execute<{ c: number }>(sql`select count(*)::int as c from handover_requests`)).rows[0]!.c).toBe(0);
    expect((await env.db.execute<{ c: number }>(sql`select count(*)::int as c from posts where id = ${found.id}`)).rows[0]!.c).toBe(0);
  });
});

describe('계정 삭제와 인수 처리의 동시 실행', () => {
  it('DELETE /me 와 인수 verify/reject/complete 를 동시에 반복해도 교착·500 없이 끝난다', async () => {
    for (let i = 0; i < 6; i++) {
      const { finder, owner, found, conv } = await scenario();
      const h = (await owner.client.post(`/conversations/${conv.id}/handover`, { postId: found.id })).body;
      const results = await Promise.all([
        finder.client.req('DELETE', '/me', { password: 'Test-Pass-77' }),
        finder.client.post(`/handovers/${h.id}/verify`, { note: 'x' }),
        owner.client.post(`/handovers/${h.id}/complete`),
        finder.client.post(`/handovers/${h.id}/reject`),
      ]);
      expect(results.map((r) => r.status).filter((s) => s >= 500), `iteration ${i}`).toEqual([]);
      expect(results[0]!.status).toBe(204);
      const active = await env.db.execute<{ c: number }>(sql`select count(*)::int as c from handover_requests where status in ('REQUESTED','VERIFIED')`);
      expect(active.rows[0]!.c).toBe(0);
      await env.reset();
    }
  });
});
