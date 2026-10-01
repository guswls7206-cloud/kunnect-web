import { existsSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import { schema } from '../src/db/client.js';
import { runCleanup } from '../src/jobs/cleanup.js';
import { recoverStaleJobs, runNextJob, setMatchHandler } from '../src/jobs/queue.js';
import { maskContacts } from '../src/lib/contact-mask.js';
import { LocalDiskStorage } from '../src/storage/index.js';
import { Client, jpeg, makePost, setupEnv, signup, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => (env = await setupEnv()));
afterAll(async () => env.close());
beforeEach(async () => {
  setMatchHandler(null);
  await env.reset();
});

const rows = async <T>(q: ReturnType<typeof sql>) => (await env.db.execute<T & Record<string, unknown>>(q)).rows;

describe('인수(Handover) 계약 — 감사 F1/F2/F6', () => {
  async function scenario() {
    const finder = await signup(env.app);
    const owner = await signup(env.app);
    const found = (await makePost(finder.client, { type: 'FOUND' })).body;
    const lost = (await makePost(owner.client, { type: 'LOST' })).body;
    const conv = (await owner.client.post('/conversations', { postId: found.id, body: '제 것 같아요' })).body.conversation;
    return { finder, owner, found, lost, conv };
  }

  it('F1: 대화 항목에 handover(역할·버튼 가능 여부)가 포함되고 GET /handovers/:id 로 조회된다', async () => {
    const { finder, owner, found, conv } = await scenario();
    expect(conv.handover).toBeNull();
    const h = (await owner.client.post(`/conversations/${conv.id}/handover`, { postId: found.id })).body;
    expect(h).toMatchObject({ myRole: 'OWNER', canVerify: false, canComplete: false, status: 'REQUESTED', finderId: finder.user.id, ownerId: owner.user.id });
    const fItem = (await finder.client.get(`/conversations/${conv.id}`)).body;
    expect(fItem.handover).toMatchObject({ id: h.id, myRole: 'FINDER', canVerify: true, canReject: true });
    expect((await owner.client.get('/conversations')).body.items[0].handover.id).toBe(h.id);
    await finder.client.post(`/handovers/${h.id}/verify`, { note: 'ok' });
    const v = (await owner.client.get(`/handovers/${h.id}`)).body;
    expect(v).toMatchObject({ status: 'VERIFIED', canComplete: true, myConfirmed: false, otherConfirmed: false });
    await owner.client.post(`/handovers/${h.id}/complete`);
    const half = (await finder.client.get(`/handovers/${h.id}`)).body;
    expect(half).toMatchObject({ canComplete: true, otherConfirmed: true, myConfirmed: false });
    await finder.client.post(`/handovers/${h.id}/complete`);
    expect((await finder.client.get(`/conversations/${conv.id}`)).body.handover.status).toBe('COMPLETED');
    expect((await owner.client.get(`/posts/${found.id}`)).body.status).toBe('RETURNED');
  });

  it('F1: 분실글을 대상으로 시작해도 막다른 길이 없다(대화 상대가 습득자 역할)', async () => {
    const { finder, owner, lost } = await scenario();
    const conv = (await finder.client.post('/conversations', { postId: lost.id, body: '주웠어요' })).body.conversation;
    const h = (await owner.client.post(`/conversations/${conv.id}/handover`, { postId: lost.id })).body;
    expect(h.finderId).toBe(finder.user.id);
    expect((await finder.client.post(`/handovers/${h.id}/verify`, {})).status).toBe(200);
    await owner.client.post(`/handovers/${h.id}/complete`);
    await finder.client.post(`/handovers/${h.id}/complete`);
    expect((await owner.client.get(`/posts/${lost.id}`)).body.status).toBe('RETURNED');
  });

  it('F2: 다른 사람들의 matchId 를 끼워 넣어 남의 글을 RETURNED 로 만들 수 없다', async () => {
    const { finder, owner, found, conv } = await scenario();
    const victimA = await signup(env.app);
    const victimB = await signup(env.app);
    const vLost = (await makePost(victimA.client, { type: 'LOST' })).body;
    const vFound = (await makePost(victimB.client, { type: 'FOUND' })).body;
    const [m] = await env.db.insert(schema.matches).values({ lostPostId: vLost.id, foundPostId: vFound.id, locationScore: 1, tagScore: 1, totalScore: 0.9, level: 'CANDIDATE' }).returning();
    const r = await owner.client.post(`/conversations/${conv.id}/handover`, { postId: found.id, matchId: m!.id });
    expect(r.status).toBe(404);
    // 정상 매칭이라도 postId 가 그 매칭에 속해야 한다
    const own = (await makePost(owner.client, { type: 'LOST' })).body;
    const [m2] = await env.db.insert(schema.matches).values({ lostPostId: own.id, foundPostId: found.id, locationScore: 1, tagScore: 1, totalScore: 0.9, level: 'CANDIDATE' }).returning();
    expect((await owner.client.post(`/conversations/${conv.id}/handover`, { postId: found.id, matchId: m2!.id })).status).toBe(201);
    void finder;
    expect((await victimA.client.get(`/posts/${vLost.id}`)).body.status).toBe('OPEN');
  });

  it('F6: 차단·탈퇴한 상대와의 대화에서는 인수 상태를 바꿀 수 없고 시스템 메시지도 추가되지 않는다', async () => {
    const { finder, owner, found, conv } = await scenario();
    const h = (await owner.client.post(`/conversations/${conv.id}/handover`, { postId: found.id })).body;
    const before = (await rows<{ c: number }>(sql`select count(*)::int as c from messages`))[0]!.c;
    await finder.client.post('/blocks', { userId: owner.user.id });
    const r = await finder.client.post(`/handovers/${h.id}/verify`, { note: 'x' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('READ_ONLY');
    expect((await owner.client.post(`/handovers/${h.id}/reject`)).status).toBe(409); // 차단된 대화는 읽기 전용
    expect((await rows<{ c: number }>(sql`select count(*)::int as c from messages`))[0]!.c).toBe(before);
  });
});

describe('차단 — 감사 F5/F11', () => {
  it('F5: 차단 관계에서는 댓글/답글 알림이 생성되지 않는다', async () => {
    const owner = await signup(env.app);
    const other = await signup(env.app);
    const post = (await makePost(owner.client)).body;
    await owner.client.post('/blocks', { userId: other.user.id });
    await other.client.post(`/posts/${post.id}/comments`, { body: '댓글' });
    expect((await owner.client.get('/notifications')).body.items).toHaveLength(0);
    await owner.client.del(`/blocks/${other.user.id}`);
    await other.client.post(`/posts/${post.id}/comments`, { body: '댓글2' });
    expect((await owner.client.get('/notifications')).body.items).toHaveLength(1);
  });

  it('F11: 탈퇴한 사용자는 차단 대상이 될 수 없다', async () => {
    const a = await signup(env.app);
    const b = await signup(env.app);
    await b.client.req('DELETE', '/me', { password: 'Test-Pass-77' });
    expect((await a.client.post('/blocks', { userId: b.user.id })).status).toBe(404);
  });
});

describe('보안 — 감사 F3/F7/F8/F10/F11', () => {
  it('F3: X-Forwarded-For 를 바꿔도 로그인 잠금을 우회할 수 없다(기본 trustProxy 비활성)', async () => {
    process.env.TEST_LOGIN_LOCK = '1';
    const locked = await setupEnv();
    try {
      await signup(locked.app, 'lockuser1');
      const codes: number[] = [];
      for (let i = 0; i < 8; i++) {
        const c = new Client(locked.app);
        codes.push((await c.req('POST', '/auth/login', { loginId: 'lockuser1', password: 'wrong-pass-1' }, { 'x-forwarded-for': `10.0.0.${i}` })).status);
      }
      expect(codes.slice(0, 5).every((s) => s === 401)).toBe(true);
      expect(codes.slice(5).every((s) => s === 429)).toBe(true);
    } finally {
      delete process.env.TEST_LOGIN_LOCK;
      await locked.reset();
      await locked.close();
    }
  });

  it('F7: 픽셀 수가 과도한 이미지(디컴프레션 폭탄)는 거부된다', async () => {
    const { client } = await signup(env.app);
    const bomb = await sharp({ create: { width: 8000, height: 8000, channels: 3, background: '#fff' } }).png({ compressionLevel: 9 }).toBuffer();
    const r = await client.upload(bomb, 'bomb.png', 'image/png');
    expect([413, 422]).toContain(r.status);
  });

  it('F8: 사진 파일은 로그인해야 받을 수 있고, 글에 연결된 사진은 삭제할 수 없다', async () => {
    const { client } = await signup(env.app);
    const up = await client.upload(await jpeg());
    const anon = await env.app.inject({ method: 'GET', url: up.body.url });
    expect(anon.statusCode).toBe(401);
    const authed = await env.app.inject({ method: 'GET', url: up.body.url, headers: { cookie: client.cookie } });
    expect(authed.statusCode).toBe(200);
    expect(String(authed.headers['cache-control'])).toContain('private');
    await makePost(client, { photoIds: [up.body.photoId] });
    const del = await client.del(`/photos/${up.body.photoId}`);
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe('PHOTO_IN_USE');
  });

  it('F10: 전각 숫자·제로폭 문자로 위장한 연락처도 마스킹하고, 글 제목/설명/보관 장소에도 적용한다', async () => {
    expect(maskContacts('０１０－１２３４－５６７８').masked).toBe(true);
    expect(maskContacts('0​1​0-1234-5678').masked).toBe(true);
    expect(maskContacts('ｔｅｓｔ＠ｇｍａｉｌ．ｃｏｍ').masked).toBe(true);
    const { client } = await signup(env.app);
    const r = await makePost(client, { type: 'FOUND', title: '지갑 010-1234-5678', description: '연락 me@test.com', storagePlace: '카톡: hong123' });
    expect(r.status).toBe(201);
    expect(JSON.stringify([r.body.title, r.body.description, r.body.storagePlace])).not.toMatch(/1234|test\.com|hong123/);
  });

  it('F11: Origin 없이 cross-site 로 표시된 요청은 거부, 흔한/단순 비밀번호는 거부', async () => {
    const c = new Client(env.app);
    const r = await c.req('POST', '/auth/login', { loginId: 'x', password: 'y' }, { origin: '', 'sec-fetch-site': 'cross-site' });
    expect(r.status).toBe(403);
    for (const pw of ['password123', '12345678', 'aaaaaaaa', '11112222']) {
      const s = await new Client(env.app).post('/auth/signup', { loginId: 'weakpw_user', password: pw, nickname: '약한비번' });
      expect(s.status, pw).toBe(400);
    }
  });
});

describe('세션 / DB 제약', () => {
  it('슬라이딩 만료: 만료가 가까워진 세션은 요청 시 14일로 연장되고 쿠키도 갱신된다', async () => {
    const { client } = await signup(env.app);
    await env.db.execute(sql`update sessions set expires_at = now() + interval '5 days'`);
    const res = await client.get('/me');
    expect(res.status).toBe(200);
    expect(String(res.headers['set-cookie'])).toContain('kunnect_sid=');
    const [s] = await rows<{ days: number }>(sql`select extract(epoch from (expires_at - now())) / 86400 as days from sessions`);
    expect(Number(s!.days)).toBeGreaterThan(13);
  });

  it('방금 연장된 세션은 매 요청마다 갱신하지 않는다', async () => {
    const { client } = await signup(env.app);
    const res = await client.get('/me');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('DB CHECK 제약: enum 성 컬럼에 잘못된 값은 저장되지 않는다', async () => {
    const { user } = await signup(env.app);
    await expect(env.db.execute(sql`update users set status = 'HACKED' where id = ${user.id}`)).rejects.toThrow();
    await expect(env.db.execute(sql`insert into jobs (type, payload) values ('NOPE', '{}')`)).rejects.toThrow();
  });

  it('/docs 는 개발 환경에서 Swagger UI 와 명세를 제공한다', async () => {
    const page = await env.app.inject({ method: 'GET', url: '/docs' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('SwaggerUIBundle');
    const spec = await env.app.inject({ method: 'GET', url: '/docs/openapi.yaml' });
    expect(spec.body).toContain('openapi: 3.0.3');
    expect((await env.app.inject({ method: 'GET', url: '/docs/assets/swagger-ui.css' })).statusCode).toBe(200);
  });
});

describe('멈춘 작업 복구', () => {
  it('오래된 RUNNING 작업은 QUEUED 로 복구되고, 시도 횟수 상한이면 FAILED', async () => {
    await env.db.execute(sql`insert into jobs (type, payload, status, attempts, started_at) values
      ('MATCH_POST', '{"postId":1}', 'RUNNING', 1, now() - interval '30 minutes'),
      ('MATCH_POST', '{"postId":2}', 'RUNNING', 3, now() - interval '30 minutes'),
      ('MATCH_POST', '{"postId":3}', 'RUNNING', 1, now())`);
    expect(await recoverStaleJobs(env.db)).toBe(2);
    const r = await rows<{ status: string }>(sql`select status from jobs order by id`);
    expect(r.map((x) => x.status)).toEqual(['QUEUED', 'FAILED', 'RUNNING']);
    let handled: number[] = [];
    setMatchHandler(async (id) => void handled.push(id));
    await runNextJob(env.db);
    expect(handled).toEqual([1]);
    handled = [];
  });
});

describe('만료 데이터 정리', () => {
  const opts = { postRetentionDays: 90, dmRetentionDays: 30 };

  it('종료 90일 지난 글(사진 파일·댓글·매칭·알림 포함)만 삭제하고 최근 종료/진행 중인 글은 유지한다', async () => {
    const a = await signup(env.app);
    const b = await signup(env.app);
    const up = (await a.client.upload(await jpeg())).body;
    const old = (await makePost(a.client, { photoIds: [up.photoId] })).body;
    const recent = (await makePost(a.client)).body;
    const open = (await makePost(a.client)).body;
    await b.client.post(`/posts/${old.id}/comments`, { body: '댓글' });
    await a.client.post(`/posts/${old.id}/status`, { status: 'CLOSED' });
    await a.client.post(`/posts/${recent.id}/status`, { status: 'CLOSED' });
    const stored = join(env.storageDir, up.url.replace('/api/v1/files/', ''));
    expect(existsSync(stored)).toBe(true);
    // old: 91일 전 종료, recent: 89일 전 종료
    await env.db.execute(sql`update posts set closed_at = now() - interval '91 days' where id = ${old.id}`);
    await env.db.execute(sql`update posts set closed_at = now() - interval '89 days' where id = ${recent.id}`);
    const report = await runCleanup(env.db, new LocalDiskStorage(env.storageDir), opts);
    expect(report.purgedPosts).toBe(1);
    expect(existsSync(stored)).toBe(false);
    const left = (await rows<{ id: number }>(sql`select id from posts order by id`)).map((r) => r.id);
    expect(left).toEqual([recent.id, open.id]);
    expect((await rows<{ c: number }>(sql`select count(*)::int as c from comments`))[0]!.c).toBe(0);
    expect((await b.client.get('/notifications')).status).toBe(200);
    expect((await a.client.get('/notifications')).body.items).toHaveLength(0); // 삭제된 글의 알림도 제거
  });

  it('쪽지는 마지막 메시지 후 30일이 지나면(종료 여부와 무관) 삭제, 최근 활동이 있으면 유지', async () => {
    const a = await signup(env.app);
    const b = await signup(env.app);
    const c = await signup(env.app);
    const d = await signup(env.app);
    const c1 = (await a.client.post('/conversations', { targetUserId: b.user.id, body: '옛 대화' })).body.conversation.id;
    const c2 = (await a.client.post('/conversations', { targetUserId: c.user.id, body: '최근 활동' })).body.conversation.id;
    const c3 = (await a.client.post('/conversations', { targetUserId: d.user.id, body: '미종료' })).body.conversation.id;
    await env.db.execute(sql`update conversations set closed_at = now() - interval '40 days', last_message_at = now() - interval '35 days' where id = ${c1}`);
    await env.db.execute(sql`update conversations set closed_at = now() - interval '40 days', last_message_at = now() - interval '2 days' where id = ${c2}`);
    await env.db.execute(sql`update conversations set last_message_at = now() - interval '200 days' where id = ${c3}`);
    const report = await runCleanup(env.db, new LocalDiskStorage(env.storageDir), opts);
    expect(report.purgedConversations).toBe(2); // c1(35일 무활동), c3(종료되지 않았어도 200일 무활동)
    expect((await rows<{ id: number }>(sql`select id from conversations order by id`)).map((r) => r.id)).toEqual([c2]);
    expect((await rows<{ c: number }>(sql`select count(*)::int as c from messages where conversation_id = ${c1}`))[0]!.c).toBe(0);
  });

  it('만료 세션, 24시간 지난 임시 사진, 고아 파일을 삭제하고 새 임시 사진/최근 파일은 유지', async () => {
    const { client } = await signup(env.app);
    const tmpOld = (await client.upload(await jpeg(50, 50))).body;
    const tmpNew = (await client.upload(await jpeg(60, 60))).body;
    await env.db.execute(sql`update post_photos set created_at = now() - interval '25 hours' where id = ${tmpOld.photoId}`);
    const oldFile = join(env.storageDir, tmpOld.url.replace('/api/v1/files/', ''));
    const newFile = join(env.storageDir, tmpNew.url.replace('/api/v1/files/', ''));
    // 고아 파일(DB 에 없음): 오래된 것 1개, 방금 만든 것 1개
    mkdirSync(join(env.storageDir, 'photos'), { recursive: true });
    const orphanOld = join(env.storageDir, 'photos', 'orphan-old.jpg');
    const orphanNew = join(env.storageDir, 'photos', 'orphan-new.jpg');
    writeFileSync(orphanOld, 'x');
    writeFileSync(orphanNew, 'x');
    const past = new Date(Date.now() - 3 * 24 * 3600_000);
    utimesSync(orphanOld, past, past);
    await env.db.execute(sql`insert into sessions (id, user_id, expires_at) values ('expired-session', (select id from users limit 1), now() - interval '1 day')`);
    const report = await runCleanup(env.db, new LocalDiskStorage(env.storageDir), opts);
    expect(report).toMatchObject({ expiredSessions: 1, tempPhotos: 1, orphanFiles: 1 });
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(newFile)).toBe(true);
    expect(existsSync(orphanOld)).toBe(false);
    expect(existsSync(orphanNew)).toBe(true);
    expect((await client.get('/me')).status).toBe(200); // 유효한 세션은 유지
  });
});

describe('계정 삭제 (DELETE /me)', () => {
  it('비밀번호 확인 후 익명화: 로그인 불가, 세션 폐기, 글·댓글 즉시 삭제, 대화는 유지·읽기 전용', async () => {
    const a = await signup(env.app, 'leaver1');
    const b = await signup(env.app, 'stayer1');
    const myPost = (await makePost(a.client)).body;
    const bPost = (await makePost(b.client)).body;
    await a.client.post(`/posts/${bPost.id}/comments`, { body: '내 댓글(답글 없음)' });
    const withReply = (await a.client.post(`/posts/${bPost.id}/comments`, { body: '내 댓글(답글 있음)' })).body.comment;
    await b.client.post(`/posts/${bPost.id}/comments`, { body: '답글', parentId: withReply.id });
    const conv = (await a.client.post('/conversations', { targetUserId: b.user.id, body: '안녕' })).body.conversation;

    expect((await a.client.req('DELETE', '/me', { password: 'wrong-pass-9' })).status).toBe(403);
    expect((await a.client.req('DELETE', '/me', { password: 'Test-Pass-77' })).status).toBe(204);
    expect((await a.client.get('/me')).status).toBe(401);
    expect((await new Client(env.app).post('/auth/login', { loginId: 'leaver1', password: 'Test-Pass-77' })).status).toBe(401);

    const [u] = await rows<{ login_id: string; nickname: string; password_hash: string; status: string }>(sql`select login_id, nickname, password_hash, status from users where id = ${a.user.id}`);
    expect(u).toMatchObject({ status: 'DELETED', login_id: `deleted_${a.user.id}` });
    expect(u!.nickname).toContain('탈퇴한사용자');
    expect(u!.password_hash).toBe('!deleted');
    // [사용자 결정] 탈퇴 시 글·댓글은 즉시 영구 삭제: 글은 DB 에서 사라져 404, 내 댓글과 그 답글도 모두 삭제
    expect((await b.client.get(`/posts/${myPost.id}`)).status).toBe(404);
    expect((await env.db.execute<{ c: number }>(sql`select count(*)::int as c from posts where author_id = ${a.user.id}`)).rows[0]!.c).toBe(0);
    expect((await b.client.get(`/posts/${bPost.id}/comments`)).body.items).toEqual([]);
    expect((await env.db.execute<{ c: number }>(sql`select count(*)::int as c from comments`)).rows[0]!.c).toBe(0);
    // 대화: 상대는 읽기만 가능
    const item = (await b.client.get(`/conversations/${conv.id}`)).body;
    expect(item.readOnly).toBe(true);
    expect((await b.client.post(`/conversations/${conv.id}/messages`, { body: '답장' })).status).toBe(409);
    expect((await b.client.post('/conversations', { targetUserId: a.user.id, body: 'x' })).status).toBe(404);
    // 쪽지는 새 보존 규칙(마지막 메시지 후 30일)을 따르므로 탈퇴가 대화를 닫거나 지우지 않는다
    const [c] = await rows<{ closed_at: Date | null }>(sql`select closed_at from conversations where id = ${conv.id}`);
    expect(c!.closed_at).toBeNull();
    expect((await b.client.get(`/conversations/${conv.id}/messages`)).body.items).toHaveLength(1);
    // 같은 아이디로 다시 가입 가능(아이디 해제됨)
    expect((await new Client(env.app).post('/auth/signup', { loginId: 'leaver1', password: 'Test-Pass-77', nickname: '새닉네임' })).status).toBe(201);
  });
});
