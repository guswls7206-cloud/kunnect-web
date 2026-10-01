import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { setMatchHandler } from '../src/jobs/queue.js';
import { isActiveHandoverViolation } from '../src/modules/handovers/service.js';
import { makePost, setupEnv, signup, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => (env = await setupEnv()));
afterAll(async () => env.close());
beforeEach(async () => {
  setMatchHandler(null);
  await env.reset();
});

const pg = (code: string, constraint?: string) => Object.assign(new Error('pg'), { code, constraint });

describe('isActiveHandoverViolation', () => {
  it('23505 + handover_active_conv_uq 만 true (드리즌이 감싼 cause 포함)', () => {
    expect(isActiveHandoverViolation(pg('23505', 'handover_active_conv_uq'))).toBe(true);
    expect(isActiveHandoverViolation(Object.assign(new Error('drizzle'), { cause: pg('23505', 'handover_active_conv_uq') }))).toBe(true);
    expect(isActiveHandoverViolation(pg('23505', 'users_login_id_key'))).toBe(false);
    expect(isActiveHandoverViolation(pg('23503', 'handover_active_conv_uq'))).toBe(false);
    expect(isActiveHandoverViolation(new Error('x'))).toBe(false);
    expect(isActiveHandoverViolation(null)).toBe(false);
    expect(isActiveHandoverViolation(undefined)).toBe(false);
  });

  it('실제 DB 가 던지는 위반 오류(드리즌 경유)를 인식한다', async () => {
    const a = await signup(env.app);
    const b = await signup(env.app);
    const post = (await makePost(a.client, { type: 'FOUND' })).body;
    const conv = (await b.client.post('/conversations', { postId: post.id, body: '안녕' })).body.conversation;
    await env.db.execute(sql`insert into handover_requests (conversation_id, post_id, requester_id, status) values (${conv.id}, ${post.id}, ${b.user.id}, 'REQUESTED')`);
    const err = await env.db
      .execute(sql`insert into handover_requests (conversation_id, post_id, requester_id, status) values (${conv.id}, ${post.id}, ${b.user.id}, 'VERIFIED')`)
      .then(() => null, (e: unknown) => e);
    expect(err).toBeTruthy();
    expect(isActiveHandoverViolation(err)).toBe(true);
  });
});

describe('인수 시작: DB 유니크 위반은 500 이 아니라 409 ALREADY_REQUESTED', () => {
  it('앱 수준 검사를 통과한 경합을 모사(삽입 시 인덱스 위반을 일으키는 트리거)해도 409', async () => {
    const finder = await signup(env.app);
    const owner = await signup(env.app);
    const found = (await makePost(finder.client, { type: 'FOUND' })).body;
    const conv = (await owner.client.post('/conversations', { postId: found.id, body: '제 것 같아요' })).body.conversation;
    await env.db.execute(sql`
      create or replace function test_force_active_violation() returns trigger as $$
      begin
        raise exception 'duplicate key value violates unique constraint "handover_active_conv_uq"'
          using errcode = '23505', constraint = 'handover_active_conv_uq';
      end $$ language plpgsql`);
    await env.db.execute(sql`create trigger test_force_active_violation before insert on handover_requests for each row execute function test_force_active_violation()`);
    try {
      const r = await owner.client.post(`/conversations/${conv.id}/handover`, { postId: found.id });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('ALREADY_REQUESTED');
    } finally {
      await env.db.execute(sql`drop trigger if exists test_force_active_violation on handover_requests`);
      await env.db.execute(sql`drop function if exists test_force_active_violation()`);
    }
    // 트리거 제거 후에는 정상 생성되고, 실패한 시도의 시스템 메시지는 롤백되어 남지 않는다
    const msgs = await env.db.execute<{ c: number }>(sql`select count(*)::int as c from messages where conversation_id = ${conv.id} and type = 'SYSTEM'`);
    expect(msgs.rows[0]!.c).toBe(0);
    expect((await owner.client.post(`/conversations/${conv.id}/handover`, { postId: found.id })).status).toBe(201);
  });

  it('다른 제약 위반(23505 이지만 다른 인덱스)은 409 로 숨기지 않고 5xx 로 드러난다', async () => {
    const finder = await signup(env.app);
    const owner = await signup(env.app);
    const found = (await makePost(finder.client, { type: 'FOUND' })).body;
    const conv = (await owner.client.post('/conversations', { postId: found.id, body: '제 것 같아요' })).body.conversation;
    await env.db.execute(sql`
      create or replace function test_other_violation() returns trigger as $$
      begin
        raise exception 'duplicate key' using errcode = '23505', constraint = 'some_other_uq';
      end $$ language plpgsql`);
    await env.db.execute(sql`create trigger test_other_violation before insert on handover_requests for each row execute function test_other_violation()`);
    try {
      const r = await owner.client.post(`/conversations/${conv.id}/handover`, { postId: found.id });
      expect(r.status).toBe(500);
    } finally {
      await env.db.execute(sql`drop trigger if exists test_other_violation on handover_requests`);
      await env.db.execute(sql`drop function if exists test_other_violation()`);
    }
  });
});
