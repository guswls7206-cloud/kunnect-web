import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { MAX_SESSIONS_PER_USER } from '../src/modules/auth/plugin.js';
import { Client, setupEnv, signup, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => (env = await setupEnv()));
afterAll(async () => env.close());
beforeEach(async () => env.reset());

const login = (c: Client, loginId: string, password = 'Test-Pass-77', headers: Record<string, string> = {}) => c.req('POST', '/auth/login', { loginId, password }, headers);

describe('세션 보안', () => {
  it('로그인하면 제시한 기존 세션은 폐기되고 항상 새 토큰이 발급된다(세션 고정 방지)', async () => {
    await signup(env.app, 'rotateuser');
    const c = new Client(env.app);
    await login(c, 'rotateuser');
    const oldCookie = c.cookie;
    await login(c, 'rotateuser'); // 같은 클라이언트가 기존 쿠키를 들고 다시 로그인
    expect(c.cookie).not.toBe(oldCookie);
    const stale = new Client(env.app);
    stale.cookie = oldCookie;
    expect((await stale.get('/me')).status).toBe(401);
    expect((await c.get('/me')).status).toBe(200);
  });

  it('모든 기기에서 로그아웃하면 내 세션이 전부 폐기되고 다른 사용자 세션은 유지된다', async () => {
    await signup(env.app, 'logoutall1');
    const other = await signup(env.app, 'logoutall2');
    const a = new Client(env.app);
    const b = new Client(env.app);
    await login(a, 'logoutall1');
    await login(b, 'logoutall1');
    expect((await a.post('/auth/logout-all')).status).toBe(204);
    expect((await b.get('/me')).status).toBe(401);
    expect((await a.get('/me')).status).toBe(401);
    expect((await other.client.get('/me')).status).toBe(200);
  });

  it(`동시 세션은 ${MAX_SESSIONS_PER_USER}개까지: 초과하면 가장 오래된 세션부터 폐기된다`, async () => {
    await signup(env.app, 'sessioncap');
    const clients: Client[] = [];
    for (let i = 0; i < MAX_SESSIONS_PER_USER + 1; i++) {
      const c = new Client(env.app);
      await login(c, 'sessioncap');
      clients.push(c);
    }
    expect((await clients[0]!.get('/me')).status).toBe(401); // 가장 오래된 것 폐기
    for (const c of clients.slice(1)) expect((await c.get('/me')).status).toBe(200);
    const n = await env.db.execute<{ c: number }>(sql`select count(*)::int as c from sessions`);
    expect(n.rows[0]!.c).toBe(MAX_SESSIONS_PER_USER);
  });
});

describe('Origin 필수화 (CSRF)', () => {
  it('세션 쿠키가 있는 상태 변경 요청은 Origin 이 없으면 403, GET 과 쿠키 없는 요청은 통과', async () => {
    const { client } = await signup(env.app, 'originreq');
    const noOrigin = await client.req('PATCH', '/me/settings', { notifyMatch: false }, { origin: '' });
    expect(noOrigin.status).toBe(403);
    expect(noOrigin.body.error.code).toBe('BAD_ORIGIN');
    const injected = await env.app.inject({ method: 'PATCH', url: '/api/v1/me/settings', payload: { notifyMatch: false }, headers: { cookie: client.cookie } });
    expect(injected.statusCode).toBe(403);
    const get = await env.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: client.cookie } });
    expect(get.statusCode).toBe(200);
    // 쿠키가 없는 가입/로그인은 Origin 없이도 가능(비브라우저 클라이언트)
    const anon = await env.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { loginId: 'originreq', password: 'Test-Pass-77' } });
    expect(anon.statusCode).toBe(200);
    // 허용된 Origin 은 통과
    expect((await client.patch('/me/settings', { notifyMatch: false })).status).toBe(200);
  });
});

describe('로그인 잠금 DoS 완화', () => {
  it('공격자가 아이디 단독 한도(30회)를 채워도 평소 IP 로 로그인에 성공한 본인은 막히지 않고, 낯선 IP 는 잠긴다', async () => {
    process.env.TEST_LOGIN_LOCK = '1';
    const locked = await setupEnv();
    try {
      await signup(locked.app, 'victimuser');
      // 본인이 자신의 IP(소켓 기본 127.0.0.1)로 성공적으로 로그인한 적이 있다
      expect((await login(new Client(locked.app), 'victimuser')).status).toBe(200);
      // 공격자가 분산 시도로 아이디 단독 카운터를 한도까지 채움
      await locked.db.execute(sql`insert into rate_counters (key, count, expires_at) values ('lf:id:victimuser', 30, now() + interval '10 minutes') on conflict (key) do update set count = 30`);
      // 본인(평소 IP)은 여전히 로그인 가능
      expect((await login(new Client(locked.app), 'victimuser')).status).toBe(200);
      // 평소 IP 에서도 틀린 비밀번호는 IP+아이디 한도(5회)로 막힌다
      const codes: number[] = [];
      for (let i = 0; i < 7; i++) codes.push((await login(new Client(locked.app), 'victimuser', 'wrong-pass-1')).status);
      expect(codes.slice(0, 5).every((s) => s === 401)).toBe(true);
      expect(codes[6]).toBe(429);
      // 낯선 IP(known 기록 없음)는 아이디 단독 잠금에 걸린다: 프록시 홉 없이 소켓 주소를 바꾸기 위해 known 기록을 지워 시뮬레이션
      await locked.db.execute(sql`delete from rate_counters where key like 'lf:ok:%' or key like 'lf:ip:%'`);
      expect((await login(new Client(locked.app), 'victimuser')).status).toBe(429);
    } finally {
      delete process.env.TEST_LOGIN_LOCK;
      await locked.reset();
      await locked.close();
    }
  });

  it('잠금은 영구적이지 않다: 카운터가 만료되면 다시 로그인할 수 있다', async () => {
    process.env.TEST_LOGIN_LOCK = '1';
    const locked = await setupEnv();
    try {
      await signup(locked.app, 'expiryuser');
      await locked.db.execute(sql`insert into rate_counters (key, count, expires_at) values ('lf:ip:127.0.0.1|expiryuser', 5, now() + interval '10 minutes')`);
      expect((await login(new Client(locked.app), 'expiryuser')).status).toBe(429);
      await locked.db.execute(sql`update rate_counters set expires_at = now() - interval '1 second'`);
      expect((await login(new Client(locked.app), 'expiryuser')).status).toBe(200);
    } finally {
      delete process.env.TEST_LOGIN_LOCK;
      await locked.reset();
      await locked.close();
    }
  });
});
