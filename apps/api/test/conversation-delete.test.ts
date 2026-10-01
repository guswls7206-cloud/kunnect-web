import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { makePost, setupEnv, signup, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => (env = await setupEnv()));
afterAll(async () => env.close());
beforeEach(async () => env.reset());

const count = async (table: string, where = 'true') => (await env.db.execute<{ c: number }>(sql.raw(`select count(*)::int as c from ${table} where ${where}`))).rows[0]!.c;

async function pair() {
  const a = await signup(env.app);
  const b = await signup(env.app);
  const first = (await a.client.post('/conversations', { targetUserId: b.user.id, body: '첫 쪽지(A)' })).body;
  const conv = first.conversation as { id: number };
  await b.client.post(`/conversations/${conv.id}/messages`, { body: '답장(B)' });
  return { a, b, conv };
}
const bodies = async (c: { get: (u: string) => Promise<{ body: { items: { body: string }[] } }> }, id: number) => (await c.get(`/conversations/${id}/messages`)).body.items.map((m) => m.body);

describe('DELETE /conversations/{id} — 기본', () => {
  it('내 쪽지함에서만 사라지고 상대의 쪽지함과 내용은 그대로이며, 직접 조회는 404', async () => {
    const { a, b, conv } = await pair();
    expect((await a.client.del(`/conversations/${conv.id}`)).status).toBe(204);
    expect((await a.client.get('/conversations')).body.items).toEqual([]);
    expect((await a.client.get(`/conversations/${conv.id}`)).status).toBe(404);
    expect((await a.client.get(`/conversations/${conv.id}/messages`)).status).toBe(404);
    expect((await a.client.post(`/conversations/${conv.id}/messages`, { body: '삭제 후 직접 전송' })).status).toBe(404);
    expect((await a.client.post(`/conversations/${conv.id}/read`, { lastMessageId: 1 })).status).toBe(404);
    // 상대는 영향 없음
    expect((await b.client.get('/conversations')).body.items).toHaveLength(1);
    expect(await bodies(b.client, conv.id)).toEqual(['첫 쪽지(A)', '답장(B)']);
  });

  it('멱등(두 번째 호출도 204), 참여자가 아니거나 없는 대화는 404, 비로그인은 401', async () => {
    const { a, conv } = await pair();
    const c = await signup(env.app);
    expect((await a.client.del(`/conversations/${conv.id}`)).status).toBe(204);
    expect((await a.client.del(`/conversations/${conv.id}`)).status).toBe(204);
    expect((await a.client.del('/conversations/99999')).status).toBe(404);
    const r = await c.client.del(`/conversations/${conv.id}`);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('NOT_FOUND');
  });

  it('IDOR: 제3자의 삭제 시도는 404 이고 다른 사람들의 쪽지함에 아무 영향이 없다', async () => {
    const { a, b, conv } = await pair();
    const c = await signup(env.app);
    expect((await c.client.del(`/conversations/${conv.id}`)).status).toBe(404);
    expect((await a.client.get('/conversations')).body.items).toHaveLength(1);
    expect((await b.client.get('/conversations')).body.items).toHaveLength(1);
    expect(await count('conversation_members', 'deleted_at is not null')).toBe(0);
  });

  it('읽지 않음 수와 이 대화의 쪽지 알림이 사라진다', async () => {
    const { a, b, conv } = await pair();
    await b.client.post(`/conversations/${conv.id}/messages`, { body: '안 읽은 쪽지' });
    expect((await a.client.get('/me')).body.unread.messages).toBeGreaterThan(0);
    expect((await a.client.get('/notifications')).body.items.some((n: { type: string }) => n.type === 'MESSAGE')).toBe(true);
    await a.client.del(`/conversations/${conv.id}`);
    expect((await a.client.get('/notifications/unread-count')).body).toEqual({ notifications: 0, messages: 0 });
    expect((await a.client.get('/notifications')).body.items.filter((n: { type: string }) => n.type === 'MESSAGE')).toEqual([]);
  });
});

describe('삭제 후 되살아남(삭제 이후 메시지만 보임)', () => {
  it('상대가 새 쪽지를 보내면 다시 나타나고 새 메시지만 보인다(이전 내용 복구 안 됨)', async () => {
    const { a, b, conv } = await pair();
    await a.client.del(`/conversations/${conv.id}`);
    await b.client.post(`/conversations/${conv.id}/messages`, { body: '삭제 후 새 쪽지' });
    const list = (await a.client.get('/conversations')).body.items;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: conv.id, unread: 1 });
    expect(await bodies(a.client, conv.id)).toEqual(['삭제 후 새 쪽지']);
    expect((await a.client.get(`/conversations/${conv.id}`)).status).toBe(200);
    // 상대(B)는 전체 내용을 계속 본다
    expect(await bodies(b.client, conv.id)).toEqual(['첫 쪽지(A)', '답장(B)', '삭제 후 새 쪽지']);
    expect((await a.client.get('/me')).body.unread.messages).toBe(1);
  });

  it('내가 같은 사용자에게 다시 쪽지를 보내면(POST /conversations) 같은 대화가 되살아나고 새 메시지만 보인다', async () => {
    const { a, b, conv } = await pair();
    await a.client.del(`/conversations/${conv.id}`);
    const again = await a.client.post('/conversations', { targetUserId: b.user.id, body: '다시 연락드려요' });
    expect(again.status).toBe(200); // 같은 쌍 대화 재사용
    expect(again.body.conversation.id).toBe(conv.id);
    expect(await bodies(a.client, conv.id)).toEqual(['다시 연락드려요']);
    expect((await a.client.get('/conversations')).body.items).toHaveLength(1);
    expect(await count('conversations')).toBe(1);
  });

  it('되살아난 뒤 다시 삭제하면 그 시점까지 다시 숨겨진다', async () => {
    const { a, b, conv } = await pair();
    await a.client.del(`/conversations/${conv.id}`);
    await b.client.post(`/conversations/${conv.id}/messages`, { body: '두 번째 새 쪽지' });
    expect((await a.client.del(`/conversations/${conv.id}`)).status).toBe(204);
    expect((await a.client.get('/conversations')).body.items).toEqual([]);
    await b.client.post(`/conversations/${conv.id}/messages`, { body: '세 번째' });
    expect(await bodies(a.client, conv.id)).toEqual(['세 번째']);
  });
});

describe('양쪽 모두 삭제하면 영구 삭제', () => {
  it('양쪽이 삭제하고 새 메시지가 없으면 대화·메시지가 즉시 삭제된다(순서 무관)', async () => {
    const { a, b, conv } = await pair();
    await a.client.del(`/conversations/${conv.id}`);
    expect(await count('conversations')).toBe(1);
    expect((await b.client.del(`/conversations/${conv.id}`)).status).toBe(204);
    expect(await count('conversations')).toBe(0);
    expect(await count('messages')).toBe(0);
    expect(await count('conversation_members')).toBe(0);
    expect((await b.client.del(`/conversations/${conv.id}`)).status).toBe(404); // 이제 존재하지 않음
  });

  it('한쪽이 삭제한 뒤 상대가 새 쪽지를 보내고 그 상대도 삭제해도, 새 쪽지를 아직 못 본 쪽이 있으면 영구 삭제되지 않는다', async () => {
    const { a, b, conv } = await pair();
    await a.client.del(`/conversations/${conv.id}`);
    await b.client.post(`/conversations/${conv.id}/messages`, { body: 'A 에게 새 쪽지' });
    await b.client.del(`/conversations/${conv.id}`);
    expect(await count('conversations')).toBe(1);
    expect(await bodies(a.client, conv.id)).toEqual(['A 에게 새 쪽지']);
  });

  it('상대가 탈퇴한 대화는 한쪽 삭제만으로 영구 삭제된다(볼 사람이 없음)', async () => {
    const { a, b, conv } = await pair();
    await b.client.req('DELETE', '/me', { password: 'Test-Pass-77' });
    expect((await a.client.del(`/conversations/${conv.id}`)).status).toBe(204);
    expect(await count('conversations')).toBe(0);
  });
});

describe('인수 요청과의 관계', () => {
  async function withHandover() {
    const finder = await signup(env.app);
    const owner = await signup(env.app);
    const found = (await makePost(finder.client, { type: 'FOUND' })).body;
    const conv = (await owner.client.post('/conversations', { postId: found.id, body: '제 것 같아요' })).body.conversation;
    const h = (await owner.client.post(`/conversations/${conv.id}/handover`, { postId: found.id })).body;
    return { finder, owner, found, conv, h };
  }

  it('진행 중인 인수 요청(REQUESTED/VERIFIED)이 있으면 409 ACTIVE_HANDOVER, 거절/완료 후에는 삭제 가능', async () => {
    const { finder, owner, conv, h } = await withHandover();
    const r = await owner.client.del(`/conversations/${conv.id}`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('ACTIVE_HANDOVER');
    await finder.client.post(`/handovers/${h.id}/verify`, { note: 'ok' });
    expect((await finder.client.del(`/conversations/${conv.id}`)).status).toBe(409); // VERIFIED 도 마찬가지
    expect((await finder.client.post(`/handovers/${h.id}/reject`)).status).toBe(200);
    expect((await owner.client.del(`/conversations/${conv.id}`)).status).toBe(204);
    expect((await owner.client.get('/conversations')).body.items).toEqual([]);
  });

  it('차단 관계(읽기 전용) 대화는 진행 중 인수를 자동 거절하고 삭제된다', async () => {
    const { finder, owner, conv, h } = await withHandover();
    await finder.client.post('/blocks', { userId: owner.user.id });
    expect((await owner.client.del(`/conversations/${conv.id}`)).status).toBe(204);
    expect((await env.db.execute<{ status: string }>(sql`select status from handover_requests where id = ${h.id}`)).rows[0]!.status).toBe('REJECTED');
  });

  it('차단된 상대와의 대화, 탈퇴한 상대와의 대화도 삭제할 수 있다', async () => {
    const { a, b, conv } = await pair();
    await a.client.post('/blocks', { userId: b.user.id });
    expect((await a.client.del(`/conversations/${conv.id}`)).status).toBe(204);
    expect((await b.client.del(`/conversations/${conv.id}`)).status).toBe(204);
    expect(await count('conversations')).toBe(0);
  });
});

describe('동시성·제한', () => {
  it('삭제와 상대의 쪽지 전송을 동시에 반복해도 500 없이 끝나고, 보이는 메시지는 삭제 이후 것뿐이다', async () => {
    for (let i = 0; i < 5; i++) {
      const { a, b, conv } = await pair();
      const sends = Array.from({ length: 4 }, (_, k) => b.client.post(`/conversations/${conv.id}/messages`, { body: `동시 ${k}` }));
      const results = await Promise.all([a.client.del(`/conversations/${conv.id}`), ...sends]);
      expect(results.filter((r) => r.status >= 500), `iteration ${i}`).toEqual([]);
      const visible = await a.client.get(`/conversations/${conv.id}/messages`);
      if (visible.status === 200) {
        const texts = visible.body.items.map((m: { body: string }) => m.body);
        expect(texts.every((t: string) => t.startsWith('동시'))).toBe(true); // 삭제 전 메시지는 없다
      }
      await env.reset();
    }
  });

  it('양쪽이 동시에 삭제해도 교착·500 없이 대화가 정리된다', async () => {
    for (let i = 0; i < 5; i++) {
      const { a, b, conv } = await pair();
      const results = await Promise.all([a.client.del(`/conversations/${conv.id}`), b.client.del(`/conversations/${conv.id}`)]);
      expect(results.filter((r) => r.status >= 500), `iteration ${i}`).toEqual([]);
      expect(results.every((r) => [204, 404].includes(r.status))).toBe(true);
      expect(await count('conversations')).toBe(0);
      await env.reset();
    }
  });

  it('삭제와 인수 요청 생성이 동시에 와도 500 없이 끝난다', async () => {
    for (let i = 0; i < 4; i++) {
      const finder = await signup(env.app);
      const owner = await signup(env.app);
      const found = (await makePost(finder.client, { type: 'FOUND' })).body;
      const conv = (await owner.client.post('/conversations', { postId: found.id, body: '문의' })).body.conversation;
      const results = await Promise.all([owner.client.del(`/conversations/${conv.id}`), owner.client.post(`/conversations/${conv.id}/handover`, { postId: found.id })]);
      expect(results.filter((r) => r.status >= 500), `iteration ${i}`).toEqual([]);
      await env.reset();
    }
  });

  it('시간당 60회를 넘으면 429 (레이트 리밋 활성 환경)', async () => {
    const limited = await setupEnv({ rateLimitEnabled: true });
    try {
      const a = await signup(limited.app);
      let last = 0;
      for (let i = 0; i < 62; i++) last = (await a.client.del('/conversations/99999')).status;
      expect(last).toBe(429);
    } finally {
      await limited.reset();
      await limited.close();
    }
  });
});

describe('다른 기능과의 상호작용', () => {
  it('삭제한(숨겨진) 대화의 직접 접근(조회·설정·나가기)은 404 로 막힌다', async () => {
    const { a, conv } = await pair();
    await a.client.del(`/conversations/${conv.id}`);
    expect((await a.client.get(`/conversations/${conv.id}`)).status).toBe(404);
    expect((await a.client.patch(`/conversations/${conv.id}/settings`, { muted: true })).status).toBe(404);
    expect((await a.client.post(`/conversations/${conv.id}/leave`)).status).toBe(404);
  });
});
