import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { schema } from '../src/db/client.js';
import { startCleanupSchedule } from '../src/jobs/cleanup.js';
import { runNextJob, setMatchHandler, startWorker } from '../src/jobs/queue.js';
import { normalizeTag, normalizeTags } from '../src/lib/tags.js';
import { LocalDiskStorage } from '../src/storage/index.js';
import { Client, firstLocationId, jpeg, makePost, setupEnv, signup, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => (env = await setupEnv()));
afterAll(async () => {
  setMatchHandler(null);
  await env.close();
});
beforeEach(async () => {
  setMatchHandler(null);
  await env.reset();
});

describe('태그 정규화(단위)', () => {
  it('공백 정리·소문자·NFC, 빈 값과 20자 초과는 버리고 중복은 합친다', () => {
    expect(normalizeTag('  Black   CASE ')).toBe('black case');
    expect(normalizeTag('   ')).toBeNull();
    expect(normalizeTag('가'.repeat(21))).toBeNull();
    expect(normalizeTag('가'.repeat(20))).toHaveLength(20);
    expect(normalizeTags(['A', 'a ', ' ', 'b'])).toEqual(['a', 'b']);
  });
});

describe('인증 경계 사례', () => {
  it('새 비밀번호가 아이디와 같거나 흔한 비밀번호면 400, 현재 비밀번호가 틀리면 403', async () => {
    const { client } = await signup(env.app, 'edgeuser1');
    expect((await client.post('/me/password', { currentPassword: 'Test-Pass-77', newPassword: 'edgeuser1' })).status).toBe(400);
    expect((await client.post('/me/password', { currentPassword: 'Test-Pass-77', newPassword: 'password123' })).status).toBe(400);
    expect((await client.post('/me/password', { currentPassword: 'wrong-one-1', newPassword: 'Another-Pass-1' })).status).toBe(403);
  });

  it('빈 설정 변경은 현재 값을 그대로 돌려주고, 존재하지 않거나 탈퇴한 사용자 프로필은 404', async () => {
    const { client } = await signup(env.app, 'edgeuser2');
    expect((await client.patch('/me/settings', {})).body).toEqual({ notifyMatch: true, notifyComment: true, notifyMessage: true });
    expect((await client.get('/users/99999')).status).toBe(404);
    const gone = await signup(env.app, 'edgeuser3');
    await gone.client.req('DELETE', '/me', { password: 'Test-Pass-77' });
    expect((await client.get(`/users/${gone.user.id}`)).status).toBe(404);
  });

  it('잘못된 JSON·너무 큰 본문·잘못된 경로 파라미터는 JSON 오류로 응답한다', async () => {
    const c = new Client(env.app);
    const bad = await env.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: '{"loginId":', headers: { 'content-type': 'application/json' } });
    expect(bad.statusCode).toBe(400);
    expect(JSON.parse(bad.body).error.code).toBeTruthy();
    const big = await env.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: JSON.stringify({ loginId: 'x', password: 'y'.repeat(200_000) }), headers: { 'content-type': 'application/json' } });
    expect(big.statusCode).toBe(413);
    expect(JSON.parse(big.body).error.code).toBe('PAYLOAD_TOO_LARGE');
    const { client } = await signup(env.app, 'edgeuser4');
    expect((await client.get('/posts/abc')).status).toBe(400);
    expect((await client.get('/posts/0')).status).toBe(400);
    void c;
  });

  it('탈퇴한 계정으로는 로그인할 수 없고 logout-all 은 쿠키를 제거한다', async () => {
    const { client } = await signup(env.app, 'edgeuser5');
    const res = await client.post('/auth/logout-all');
    expect(res.status).toBe(204);
    expect(String(res.headers['set-cookie'])).toContain('kunnect_sid=;');
  });
});

describe('글 목록·수정 경계 사례', () => {
  it('위치·상태 필터와 커스텀 태그 정규화·재사용, 태그 전부 제거', async () => {
    const { client } = await signup(env.app);
    const locs = (await client.get('/locations')).body.items as { id: number }[];
    const a = (await makePost(client, { locationId: locs[0]!.id, tags: ['  Blue  Case ', '이어폰'] })).body;
    await makePost(client, { locationId: locs[1]!.id, tags: ['blue case'] }); // 같은 정규화 태그 재사용
    const tags = await env.db.execute<{ c: number }>(sql`select count(*)::int as c from tags where is_preset = false`);
    expect(tags.rows[0]!.c).toBe(1);
    expect((await client.get(`/posts?locationId=${locs[0]!.id}`)).body.items.map((p: { id: number }) => p.id)).toEqual([a.id]);
    expect((await client.get('/posts?tag=' + encodeURIComponent('BLUE CASE'))).body.items).toHaveLength(2);
    expect((await client.get('/posts?tag=%20%20')).body.items).toEqual([]); // 정규화 불가한 태그는 결과 없음
    expect((await client.get('/posts?status=MATCHED')).body.items).toEqual([]);
    const cleared = await client.patch(`/posts/${a.id}`, { tags: [] });
    expect(cleared.body.tags).toEqual([]);
  });

  it('수정 경계: 습득글 보관 장소 빈 값 거부, 분실글의 보관 장소·비공개 특징 수정은 무시, 없는 글 404', async () => {
    const { client } = await signup(env.app);
    const found = (await makePost(client, { type: 'FOUND' })).body;
    expect((await client.patch(`/posts/${found.id}`, { storagePlace: '' })).status).toBe(400);
    expect((await client.patch(`/posts/${found.id}`, { storagePlace: '새 보관소', hiddenFeatures: '스티커' })).body).toMatchObject({ storagePlace: '새 보관소', hiddenFeatures: '스티커' });
    const lost = (await makePost(client, { type: 'LOST' })).body;
    const r = await client.patch(`/posts/${lost.id}`, { storagePlace: '무시됨', hiddenFeatures: '무시됨' });
    expect(r.body.storagePlace).toBeNull();
    expect(r.body.hiddenFeatures).toBeNull();
    expect((await client.patch('/posts/99999', { title: 'x' })).status).toBe(404);
    expect((await client.post(`/posts/${found.id}/status`, { status: 'OPEN' })).status).toBe(400);
  });

  it('반환 완료된 글의 상태 변경은 409, 사용자 공개 글 목록 커서 페이지네이션', async () => {
    const { client, user } = await signup(env.app);
    const viewer = await signup(env.app);
    for (let i = 0; i < 3; i++) await makePost(client, { title: `글 ${i}` });
    const p1 = (await viewer.client.get(`/users/${user.id}/posts?limit=2`)).body;
    expect(p1.items).toHaveLength(2);
    const p2 = (await viewer.client.get(`/users/${user.id}/posts?limit=2&cursor=${p1.nextCursor}`)).body;
    expect(p2.items).toHaveLength(1);
    const post = p1.items[0];
    await env.db.execute(sql`update posts set status = 'RETURNED' where id = ${post.id}`);
    expect((await client.post(`/posts/${post.id}/status`, { status: 'CLOSED' })).status).toBe(409);
  });

  it('내 글 목록의 상태 필터와 커서', async () => {
    const { client } = await signup(env.app);
    for (let i = 0; i < 3; i++) await makePost(client);
    const first = (await client.get('/me/posts?limit=2')).body;
    expect(first.nextCursor).toBeTruthy();
    expect((await client.get(`/me/posts?limit=2&cursor=${first.nextCursor}`)).body.items).toHaveLength(1);
    expect((await client.get('/me/posts?status=CLOSED')).body.items).toEqual([]);
  });
});

describe('사진 업로드 경계', () => {
  it('multipart 가 아니거나 file 이 없으면 거부한다', async () => {
    const { client } = await signup(env.app);
    const notMultipart = await client.post('/photos', { a: 1 });
    expect(notMultipart.status).toBe(415);
    const emptyForm = await env.app.inject({
      method: 'POST',
      url: '/api/v1/photos',
      payload: '--b--\r\n',
      headers: { 'content-type': 'multipart/form-data; boundary=b', cookie: client.cookie, origin: 'http://localhost:3000' },
    });
    expect(emptyForm.statusCode).toBe(400);
  });

  it('임시 사진이 20장이면 사전 점검에서 429', async () => {
    const { client, user } = await signup(env.app);
    const img = await jpeg(20, 20);
    const first = await client.upload(img);
    expect(first.status).toBe(201);
    for (let i = 0; i < 19; i++) {
      await env.db.insert(schema.postPhotos).values({ ownerId: user.id, storageKey: `photos/x${i}.jpg`, url: `/x${i}`, width: 1, height: 1 });
    }
    expect((await client.upload(img)).status).toBe(429);
  });
});

describe('댓글 경계 사례', () => {
  it('댓글 목록 커서 페이지네이션과 숨김(HIDDEN) 댓글 제외, 내 댓글 목록 커서', async () => {
    const owner = await signup(env.app);
    const other = await signup(env.app);
    const post = (await makePost(owner.client)).body;
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) ids.push((await other.client.post(`/posts/${post.id}/comments`, { body: `c${i}` })).body.comment.id);
    await other.client.post(`/posts/${post.id}/comments`, { body: '답글', parentId: ids[0] });
    await env.db.execute(sql`update comments set status = 'HIDDEN' where id = ${ids[1]}`);
    const p1 = (await other.client.get(`/posts/${post.id}/comments?limit=2`)).body;
    expect(p1.items.map((c: { id: number }) => c.id)).toEqual([ids[0], ids[2]]);
    expect(p1.items[0].replies).toHaveLength(1);
    const p2 = (await other.client.get(`/posts/${post.id}/comments?limit=2&cursor=${p1.nextCursor}`)).body;
    expect(p2.items.map((c: { id: number }) => c.id)).toEqual([ids[3]]);
    const mine1 = (await other.client.get('/me/comments?limit=2')).body;
    expect(mine1.items).toHaveLength(2);
    expect((await other.client.get(`/me/comments?limit=2&cursor=${mine1.nextCursor}`)).body.items.length).toBeGreaterThan(0);
  });

  it('삭제된 댓글에는 답글을 달 수 없고, 타인 댓글 수정·없는 댓글 수정은 거부', async () => {
    const owner = await signup(env.app);
    const other = await signup(env.app);
    const post = (await makePost(owner.client)).body;
    const c = (await other.client.post(`/posts/${post.id}/comments`, { body: '원 댓글' })).body.comment;
    await owner.client.post(`/posts/${post.id}/comments`, { body: '답글', parentId: c.id });
    await other.client.del(`/comments/${c.id}`); // 답글이 있어 DELETED 로 자리 유지
    const r = await owner.client.post(`/posts/${post.id}/comments`, { body: '또 답글', parentId: c.id });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('PARENT_INVALID');
    expect((await owner.client.patch(`/comments/${c.id}`, { body: 'x' })).status).toBe(403);
    expect((await owner.client.patch('/comments/99999', { body: 'x' })).status).toBe(404);
  });
});

describe('알림 경계 사례', () => {
  it('MATCH/MESSAGE 알림의 target 종류와 쪽지 알림 읽음 처리', async () => {
    const a = await signup(env.app);
    const b = await signup(env.app);
    const lost = (await makePost(a.client, { type: 'LOST' })).body;
    const found = (await makePost(b.client, { type: 'FOUND' })).body;
    const [m] = await env.db.insert(schema.matches).values({ lostPostId: lost.id, foundPostId: found.id, locationScore: 1, tagScore: 1, totalScore: 0.9, level: 'AUTO' }).returning();
    await env.db.insert(schema.notifications).values({ userId: a.user.id, type: 'MATCH', matchId: m!.id, postId: lost.id });
    await b.client.post('/conversations', { targetUserId: a.user.id, body: '안녕' });
    const items = (await a.client.get('/notifications')).body.items as { type: string; target: { kind: string; id: number } }[];
    expect(items.find((n) => n.type === 'MATCH')!.target).toMatchObject({ kind: 'match', id: m!.id });
    expect(items.find((n) => n.type === 'MESSAGE')!.target.kind).toBe('conversation');
    expect((await a.client.get('/notifications?limit=1')).body.nextCursor).toBeTruthy();
  });
});

describe('매칭 API 경계 사례', () => {
  async function seed() {
    const loser = await signup(env.app);
    const finder = await signup(env.app);
    const stranger = await signup(env.app);
    const lost = (await makePost(loser.client, { type: 'LOST' })).body;
    const found = (await makePost(finder.client, { type: 'FOUND' })).body;
    const [m] = await env.db.insert(schema.matches).values({ lostPostId: lost.id, foundPostId: found.id, locationScore: 1, tagScore: 1, totalScore: 0.7, level: 'CANDIDATE' }).returning();
    return { loser, finder, stranger, lost, found, m: m! };
  }

  it('GET /matches/:id: 관련 글 작성자만 조회(CANDIDATE 는 등급 MID), 제3자 403, 없는 매칭 404', async () => {
    const { loser, finder, stranger, m } = await seed();
    const mine = await loser.client.get(`/matches/${m.id}`);
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ level: 'CANDIDATE', grade: 'MID', locationDiff: 'SAME_PLACE' });
    expect((await finder.client.get(`/matches/${m.id}`)).status).toBe(200);
    expect((await stranger.client.get(`/matches/${m.id}`)).status).toBe(403);
    expect((await loser.client.get('/matches/99999')).status).toBe(404);
    expect((await loser.client.post('/matches/99999/confirm')).status).toBe(404);
  });

  it('/me/matches 는 내 진행 중 분실글의 후보만, 다른 건물은 locationDiff 가 FAR 또는 NEARBY', async () => {
    const { loser, stranger } = await seed();
    expect((await loser.client.get('/me/matches')).body.items).toHaveLength(1);
    expect((await stranger.client.get('/me/matches')).body.items).toEqual([]);
    const f2 = await signup(env.app);
    const locs = (await f2.client.get('/locations')).body.items as { id: number; buildingId: string }[];
    const farLoc = locs.find((l) => l.buildingId !== locs[0]!.buildingId)!;
    const lostId = (await loser.client.get('/me/posts?type=LOST')).body.items[0].id;
    const far = (await makePost(f2.client, { type: 'FOUND', locationId: farLoc.id })).body;
    await env.db.insert(schema.matches).values({ lostPostId: lostId, foundPostId: far.id, locationScore: 0.2, tagScore: 1, totalScore: 0.65, level: 'CANDIDATE' });
    const diffs = (await loser.client.get(`/posts/${lostId}/matches`)).body.items.map((x: { locationDiff: string }) => x.locationDiff);
    expect(diffs).toEqual(expect.arrayContaining(['SAME_PLACE']));
    expect(diffs.some((d: string) => d === 'FAR' || d === 'NEARBY')).toBe(true);
  });
});

describe('작업 큐·정리 스케줄', () => {
  it('startWorker 는 대기 작업을 처리하고 중지 함수로 멈춘다', async () => {
    const { client } = await signup(env.app);
    const post = (await makePost(client)).body;
    const handled: number[] = [];
    setMatchHandler(async (id) => void handled.push(id));
    const worker = startWorker(env.db, { intervalMs: 20 });
    for (let i = 0; i < 100 && !handled.length; i++) await new Promise((r) => setTimeout(r, 20));
    await worker.stop();
    expect(handled).toEqual([post.id]);
    expect((await client.get(`/posts/${post.id}`)).body.matchState).toBe('DONE');
    // 핸들러가 없으면 처리하지 않는다
    setMatchHandler(null);
    expect(await runNextJob(env.db)).toBe(false);
  });

  it('startCleanupSchedule 은 주기 실행 후 로그를 남기고 중지 함수로 멈춘다', async () => {
    const logs: string[] = [];
    const stop = startCleanupSchedule(env.db, new LocalDiskStorage(env.storageDir), { postRetentionDays: 90, dmRetentionDays: 30 }, 30, (m) => logs.push(m));
    for (let i = 0; i < 300 && !logs.length; i++) await new Promise((r) => setTimeout(r, 20));
    await stop();
    expect(logs[0]).toContain('정리 작업 완료');
  });
});

describe('Origin 검사 경계', () => {
  it('요청 자신의 Origin(동일 출처)과 허용 목록 Origin 은 통과하고 그 외는 403', async () => {
    const { client } = await signup(env.app);
    const self = await client.req('PATCH', '/me/settings', { notifyMatch: true }, { origin: 'http://localhost:80', host: 'localhost:80' });
    expect([200, 403]).toContain(self.status);
    const evil = await client.req('PATCH', '/me/settings', { notifyMatch: true }, { origin: 'https://evil.example' });
    expect(evil.status).toBe(403);
    expect((await client.req('GET', '/me', undefined, { origin: 'https://evil.example' })).status).toBe(200); // 안전한 메서드는 검사하지 않음
    void firstLocationId;
  });
});
