import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { Client, setupEnv, signup, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => (env = await setupEnv()));
afterAll(async () => env.close());
beforeEach(async () => env.reset());

describe('인증', () => {
  it('가입 → 세션 쿠키 발급 → /me 조회, 비밀번호 해시는 노출되지 않는다', async () => {
    const c = new Client(env.app);
    const res = await c.post('/auth/signup', { loginId: 'Tester_1', password: 'Test-Pass-77', nickname: '테스터' });
    expect(res.status).toBe(201);
    expect(res.body.user.loginId).toBe('tester_1'); // 소문자 정규화
    expect(JSON.stringify(res.body)).not.toContain('password');
    const set = String(res.headers['set-cookie']);
    expect(set).toContain('HttpOnly');
    expect(set).toContain('SameSite=Lax');
    const me = await c.get('/me');
    expect(me.status).toBe(200);
    expect(me.body.nickname).toBe('테스터');
    expect(me.body.unread).toEqual({ notifications: 0, messages: 0 });
  });

  it('DB 에는 argon2id 해시만, 세션 토큰은 SHA-256 해시로 저장된다', async () => {
    const { client } = await signup(env.app, 'hashcheck');
    const u = await env.db.execute<{ password_hash: string }>(sql`select password_hash from users`);
    expect(u.rows[0]!.password_hash).toMatch(/^\$argon2id\$/);
    const token = client.cookie.split('=')[1]!;
    const s = await env.db.execute<{ id: string }>(sql`select id from sessions`);
    expect(s.rows[0]!.id).not.toBe(token);
    expect(s.rows[0]!.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('중복 아이디·닉네임(대소문자 무시)은 409', async () => {
    await signup(env.app, 'dupuser');
    const c = new Client(env.app);
    const a = await c.post('/auth/signup', { loginId: 'DUPUSER', password: 'Test-Pass-77', nickname: '다른닉' });
    expect(a.status).toBe(409);
    expect(a.body.error.code).toBe('LOGIN_ID_TAKEN');
    const b = await c.post('/auth/signup', { loginId: 'other_id', password: 'Test-Pass-77', nickname: '닉DUPUSER' });
    expect(b.status).toBe(409);
    expect(b.body.error.code).toBe('NICKNAME_TAKEN');
  });

  it.each([
    [{ loginId: 'ab', password: 'Test-Pass-77', nickname: '닉네임' }, 'loginId'],
    [{ loginId: 'valid_id', password: 'short', nickname: '닉네임' }, 'password'],
    [{ loginId: 'valid_id', password: 'Test-Pass-77', nickname: '<script>' }, 'nickname'],
  ])('입력 검증 실패는 400 VALIDATION_ERROR + fields: %#', async (body, field) => {
    const r = await new Client(env.app).post('/auth/signup', body);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
    expect(r.body.error.fields[field]).toBeTruthy();
  });

  it('아이디와 같은 비밀번호는 WEAK_PASSWORD', async () => {
    const r = await new Client(env.app).post('/auth/signup', { loginId: 'sameidpw1', password: 'sameidpw1', nickname: '약한비번' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('WEAK_PASSWORD');
  });

  it('로그인 성공/실패, 실패 사유는 아이디·비밀번호를 구분하지 않는다', async () => {
    await signup(env.app, 'loginuser');
    const c = new Client(env.app);
    const wrongPw = await c.post('/auth/login', { loginId: 'loginuser', password: 'wrongpass1' });
    const noUser = await c.post('/auth/login', { loginId: 'ghost_user', password: 'wrongpass1' });
    expect(wrongPw.status).toBe(401);
    expect(noUser.status).toBe(401);
    expect(wrongPw.body).toEqual(noUser.body);
    const ok = await c.post('/auth/login', { loginId: 'LoginUser', password: 'Test-Pass-77' });
    expect(ok.status).toBe(200);
    expect((await c.get('/me')).status).toBe(200);
  });

  it('로그아웃하면 세션이 폐기되어 같은 쿠키로 접근할 수 없다', async () => {
    const { client } = await signup(env.app, 'logoutuser');
    const cookie = client.cookie;
    expect((await client.post('/auth/logout')).status).toBe(204);
    const stale = new Client(env.app);
    stale.cookie = cookie;
    expect((await stale.get('/me')).status).toBe(401);
  });

  it('로그인 필요한 API 는 401 UNAUTHENTICATED', async () => {
    const c = new Client(env.app);
    for (const url of ['/me', '/posts', '/locations', '/notifications', '/conversations']) {
      const r = await c.get(url);
      expect(r.status, url).toBe(401);
      expect(r.body.error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('비밀번호 변경: 현재 비밀번호 검증, 다른 세션 폐기, 새 비밀번호로 로그인', async () => {
    const { client: a } = await signup(env.app, 'pwchange');
    const other = new Client(env.app);
    await other.post('/auth/login', { loginId: 'pwchange', password: 'Test-Pass-77' });
    expect((await a.post('/me/password', { currentPassword: 'nope-nope', newPassword: 'newpassword1' })).status).toBe(403);
    expect((await a.post('/me/password', { currentPassword: 'Test-Pass-77', newPassword: 'newpassword1' })).status).toBe(204);
    expect((await other.get('/me')).status).toBe(401); // 다른 세션 폐기
    expect((await a.get('/me')).status).toBe(200); // 현재 세션 유지
    expect((await new Client(env.app).post('/auth/login', { loginId: 'pwchange', password: 'newpassword1' })).status).toBe(200);
  });

  it('알림 설정 변경', async () => {
    const { client } = await signup(env.app, 'settings1');
    const r = await client.patch('/me/settings', { notifyComment: false });
    expect(r.body).toEqual({ notifyMatch: true, notifyComment: false, notifyMessage: true });
  });

  it('사용자 프로필은 loginId 를 노출하지 않는다', async () => {
    const { user } = await signup(env.app, 'profile1');
    const { client } = await signup(env.app, 'viewer1');
    const r = await client.get(`/users/${user.id}`);
    expect(r.status).toBe(200);
    expect(r.body.loginId).toBeUndefined();
    expect(r.body.nickname).toBe(user.nickname);
  });

  it('다른 Origin 의 상태 변경 요청은 403 BAD_ORIGIN (CSRF 완화), 허용 Origin 은 통과', async () => {
    const c = new Client(env.app);
    const bad = await c.req('POST', '/auth/login', { loginId: 'x', password: 'y' }, { origin: 'https://evil.example' });
    expect(bad.status).toBe(403);
    expect(bad.body.error.code).toBe('BAD_ORIGIN');
    const ok = await c.req('POST', '/auth/login', { loginId: 'x', password: 'y' }, { origin: 'http://localhost:3000' });
    expect(ok.status).toBe(401);
  });

  it('존재하지 않는 경로는 JSON 404', async () => {
    const r = await new Client(env.app).get('/nope');
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('NOT_FOUND');
  });
});

describe('레이트 리밋', () => {
  it('가입 IP당 시간당 5회 초과 시 429', async () => {
    const limited = await setupEnv({ rateLimitEnabled: true });
    try {
      let last = 0;
      for (let i = 0; i < 7; i++) {
        // 세션 없는 새 클라이언트(같은 IP)로 요청
        last = (await new Client(limited.app).post('/auth/signup', { loginId: `rl_user_${i}`, password: 'Test-Pass-77', nickname: `리밋${i}` })).status;
      }
      expect(last).toBe(429);
    } finally {
      await limited.reset();
      await limited.close();
    }
  });
});
