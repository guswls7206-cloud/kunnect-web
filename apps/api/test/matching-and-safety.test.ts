import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { schema } from '../src/db/client.js';
import { createMatchHandler } from '../src/jobs/match-handler.js';
import { runNextJob, setMatchHandler } from '../src/jobs/queue.js';
import { createMatchingEngine, loadMatchingConfig } from '../src/matching/index.js';
import type { MatchingEngine, RankedMatch } from '../src/matching/types.js';
import { LocalDiskStorage } from '../src/storage/index.js';
import { Client, jpeg, makePost, setupEnv, signup, type TestEnv } from './helpers.js';

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

/** 엔진 대역: 지정한 후보에 대해 고정 결과를 돌려준다(AI 호출 없음). */
function fakeEngine(grade: 'AUTO' | 'CANDIDATE' | 'IGNORE', score: number): MatchingEngine & { calls: number } {
  const e = {
    calls: 0,
    async extractAttributes(post: { id: string }) {
      return { postId: post.id, photos: [] };
    },
    async matchPair() {
      throw new Error('사용하지 않음');
    },
    async rankCandidates(post: { id: string; type: string }, candidates: { id: string }[]) {
      e.calls += 1;
      return candidates.map<RankedMatch>((c) => ({
        candidateId: c.id,
        lostPostId: post.type === 'LOST' ? post.id : c.id,
        foundPostId: post.type === 'LOST' ? c.id : post.id,
        score,
        grade,
        breakdown: { location: 1, tag: 1 },
        mode: 'NO_PHOTO',
        autoThreshold: 0.85,
        photoSource: 'NONE',
        aiReason: '테스트 근거',
        degraded: false,
      }));
    },
  };
  return e as never;
}

function useHandler(engine: MatchingEngine, noPhotoAutoNotify = true) {
  const storage = new LocalDiskStorage(env.storageDir);
  setMatchHandler(createMatchHandler({ db: env.db, storage, engine, config: loadMatchingConfig({}), noPhotoAutoNotify }));
}

describe('매칭 작업 처리(핸들러)', () => {
  it('핸들러가 없으면 작업은 QUEUED 로 남고 글은 PENDING 이다', async () => {
    const { client } = await signup(env.app);
    const post = (await makePost(client)).body;
    expect(await runNextJob(env.db)).toBe(false);
    expect((await client.get(`/posts/${post.id}`)).body.matchState).toBe('PENDING');
  });

  it('AUTO 매칭: matches 저장 + 분실자에게만 MATCH 알림 1회 (사양 문구), 재실행해도 중복 알림 없음', async () => {
    const loser = await signup(env.app);
    const finder = await signup(env.app);
    const lost = (await makePost(loser.client, { type: 'LOST' })).body;
    const found = (await makePost(finder.client, { type: 'FOUND' })).body;
    useHandler(fakeEngine('AUTO', 0.9));
    while (await runNextJob(env.db));
    const rows = await env.db.select().from(schema.matches);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ lostPostId: lost.id, foundPostId: found.id, level: 'AUTO', status: 'PENDING' });
    expect(rows[0]!.notifiedAt).toBeTruthy();
    const n = (await loser.client.get('/notifications')).body.items;
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ type: 'MATCH', text: '분실하신 물건과 비슷한 물건의 글이 작성되었습니다. 확인해 보세요.' });
    expect(n[0].target.kind).toBe('match');
    expect((await finder.client.get('/notifications')).body.items).toHaveLength(0); // 습득자에게는 알림 없음
    expect((await loser.client.get(`/posts/${lost.id}`)).body.matchState).toBe('DONE');
    // 글 수정 → 재매칭해도 알림은 다시 가지 않는다
    await finder.client.patch(`/posts/${found.id}`, { description: '내용 수정' });
    while (await runNextJob(env.db));
    expect((await loser.client.get('/notifications')).body.items).toHaveLength(1);
    expect(await env.db.select().from(schema.matches)).toHaveLength(1);
  });

  it('CANDIDATE 는 목록에만 표시되고 알림은 없다, IGNORE 는 저장하지 않는다', async () => {
    const loser = await signup(env.app);
    const finder = await signup(env.app);
    await makePost(loser.client, { type: 'LOST' });
    await makePost(finder.client, { type: 'FOUND' });
    useHandler(fakeEngine('CANDIDATE', 0.7));
    while (await runNextJob(env.db));
    expect((await loser.client.get('/notifications')).body.items).toHaveLength(0);
    const m = await env.db.select().from(schema.matches);
    expect(m).toHaveLength(1);
    expect(m[0]!.notifiedAt).toBeNull();
    // 새 엔진(IGNORE)으로 재평가하면 미결정·미알림 후보는 정리된다
    await env.db.update(schema.jobs).set({ status: 'DONE' });
    const lostPost = (await loser.client.get('/me/posts')).body.items[0];
    await loser.client.patch(`/posts/${lostPost.id}`, { description: '수정' });
    useHandler(fakeEngine('IGNORE', 0.1));
    while (await runNextJob(env.db));
    expect(await env.db.select().from(schema.matches)).toHaveLength(0);
  });

  it('차단 관계의 글은 후보에서 제외된다', async () => {
    const loser = await signup(env.app);
    const finder = await signup(env.app);
    await loser.client.post('/blocks', { userId: finder.user.id });
    await makePost(finder.client, { type: 'FOUND' });
    await makePost(loser.client, { type: 'LOST' });
    useHandler(fakeEngine('AUTO', 0.95));
    while (await runNextJob(env.db));
    expect(await env.db.select().from(schema.matches)).toHaveLength(0);
  });

  it('같은 작성자의 글끼리·종료된 글은 매칭하지 않는다', async () => {
    const a = await signup(env.app);
    await makePost(a.client, { type: 'LOST' });
    const found = (await makePost(a.client, { type: 'FOUND' })).body;
    useHandler(fakeEngine('AUTO', 0.95));
    while (await runNextJob(env.db));
    expect(await env.db.select().from(schema.matches)).toHaveLength(0);
    const b = await signup(env.app);
    const closed = (await makePost(b.client, { type: 'LOST' })).body;
    await b.client.post(`/posts/${closed.id}/status`, { status: 'CLOSED' });
    await env.db.update(schema.jobs).set({ status: 'QUEUED' });
    while (await runNextJob(env.db));
    expect((await env.db.select().from(schema.matches)).filter((m) => m.lostPostId === closed.id)).toHaveLength(0);
    void found;
  });

  it('핸들러 오류 시 재시도 후 FAILED, 글 matchState=FAILED', async () => {
    const { client } = await signup(env.app);
    const post = (await makePost(client)).body;
    setMatchHandler(async () => {
      throw new Error('DB 일시 오류');
    });
    for (let i = 0; i < 3; i++) {
      await runNextJob(env.db);
      await env.db.update(schema.jobs).set({ runAfter: new Date(0) }); // 백오프 대기 건너뛰기
    }
    const job = (await env.db.select().from(schema.jobs))[0]!;
    expect(job.status).toBe('FAILED');
    expect(job.attempts).toBe(3);
    expect(job.lastError).toContain('DB 일시 오류');
    expect((await client.get(`/posts/${post.id}`)).body.matchState).toBe('FAILED');
  });

  it('실제 엔진(API 키 없음): 양쪽 사진이 있으면 AI 단계 생략(degraded)으로 AUTO 가 CANDIDATE 로 강등되어 알림이 없다', async () => {
    const loser = await signup(env.app);
    const finder = await signup(env.app);
    const p1 = (await loser.client.upload(await jpeg(200, 200))).body.photoId;
    const p2 = (await finder.client.upload(await jpeg(200, 200))).body.photoId;
    await makePost(loser.client, { type: 'LOST', photoIds: [p1], tags: ['이어폰', '검정'] });
    await makePost(finder.client, { type: 'FOUND', photoIds: [p2], tags: ['이어폰', '검정'] });
    useHandler(createMatchingEngine({ client: null, config: loadMatchingConfig({}) }));
    while (await runNextJob(env.db));
    expect((await env.db.select().from(schema.jobs)).every((j) => j.status === 'DONE')).toBe(true);
    const m = await env.db.select().from(schema.matches);
    expect(m.every((x) => x.level !== 'AUTO')).toBe(true);
    expect((await loser.client.get('/notifications')).body.items.filter((n: { type: string }) => n.type === 'MATCH')).toHaveLength(0);
  });

  it('[정책] 한쪽이라도 사진이 없으면(NO_PHOTO) 기본적으로 AUTO 가 CANDIDATE 로 강등되어 알림이 없다, 플래그를 켜면 AUTO', async () => {
    const loser = await signup(env.app);
    const finder = await signup(env.app);
    const p1 = (await loser.client.upload(await jpeg(200, 200))).body.photoId;
    await makePost(loser.client, { type: 'LOST', photoIds: [p1], tags: ['이어폰', '검정'] });
    await makePost(finder.client, { type: 'FOUND', tags: ['이어폰', '검정'] });
    useHandler(createMatchingEngine({ client: null, config: loadMatchingConfig({}) }), false);
    while (await runNextJob(env.db));
    let m = await env.db.select().from(schema.matches);
    expect(m[0]).toMatchObject({ mode: 'NO_PHOTO', level: 'CANDIDATE' });
    expect((await loser.client.get('/notifications')).body.items).toHaveLength(0);
    // 플래그를 켠 설정으로 재평가하면 AUTO 와 알림
    await env.db.execute(sql`update jobs set status = 'QUEUED'`);
    useHandler(createMatchingEngine({ client: null, config: loadMatchingConfig({}) }), true);
    while (await runNextJob(env.db));
    m = await env.db.select().from(schema.matches);
    expect(m[0]).toMatchObject({ level: 'AUTO' });
    expect((await loser.client.get('/notifications')).body.items).toHaveLength(1);
  });
});

describe('매칭 API', () => {
  async function seedMatch() {
    const loser = await signup(env.app);
    const finder = await signup(env.app);
    const lost = (await makePost(loser.client, { type: 'LOST' })).body;
    const found = (await makePost(finder.client, { type: 'FOUND' })).body;
    const [m] = await env.db
      .insert(schema.matches)
      .values({ lostPostId: lost.id, foundPostId: found.id, locationScore: 1, tagScore: 0.9, totalScore: 0.91, level: 'AUTO', aiReason: '비슷함' })
      .returning();
    return { loser, finder, lost, found, match: m! };
  }

  it('점수 수치는 노출하지 않고 등급(HIGH/MID)만, 상대 글 카드 포함', async () => {
    const { loser, lost, found } = await seedMatch();
    const r = await loser.client.get(`/posts/${lost.id}/matches`);
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0]).toMatchObject({ level: 'AUTO', grade: 'HIGH', status: 'PENDING', aiReason: '비슷함' });
    expect(r.body.items[0].otherPost.id).toBe(found.id);
    expect(JSON.stringify(r.body)).not.toMatch(/score|0\.91/i);
  });

  it('습득자도 자기 글의 비슷한 분실글을 볼 수 있고, 타인은 403', async () => {
    const { finder, found } = await seedMatch();
    const stranger = await signup(env.app);
    expect((await finder.client.get(`/posts/${found.id}/matches`)).body.items).toHaveLength(1);
    expect((await stranger.client.get(`/posts/${found.id}/matches`)).status).toBe(403);
  });

  it('맞음: 분실글 작성자만 가능, 양쪽 글 MATCHED, 재결정 409', async () => {
    const { loser, finder, lost, found, match } = await seedMatch();
    expect((await finder.client.post(`/matches/${match.id}/confirm`)).status).toBe(403);
    const ok = await loser.client.post(`/matches/${match.id}/confirm`);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('CONFIRMED');
    expect(ok.body.suggestedConversation).toEqual({ otherUserId: found.author.id, postId: found.id });
    expect(ok.body.locationDiff).toBe('SAME_PLACE');
    expect(ok.body.otherPost.author.id).toBe(found.author.id);
    expect((await loser.client.get(`/posts/${lost.id}`)).body.status).toBe('MATCHED');
    expect((await finder.client.get(`/posts/${found.id}`)).body.status).toBe('MATCHED');
    expect((await loser.client.post(`/matches/${match.id}/reject`)).body.error.code).toBe('ALREADY_DECIDED');
  });

  it('아님: REJECTED 로 저장되고 목록에서 사라진다(재알림 방지)', async () => {
    const { loser, lost, match } = await seedMatch();
    expect((await loser.client.post(`/matches/${match.id}/reject`)).body.status).toBe('REJECTED');
    expect((await loser.client.get(`/posts/${lost.id}/matches`)).body.items).toHaveLength(0);
    expect((await loser.client.get('/me/matches')).body.items).toHaveLength(0);
  });

  it('인수 완료(양측 확인) 시 매칭된 양쪽 글이 RETURNED 가 된다', async () => {
    const { loser, finder, lost, found, match } = await seedMatch();
    await loser.client.post(`/matches/${match.id}/confirm`);
    const conv = (await loser.client.post('/conversations', { postId: found.id, body: '제 것입니다' })).body.conversation;
    const h = (await loser.client.post(`/conversations/${conv.id}/handover`, { postId: found.id, matchId: match.id })).body;
    await finder.client.post(`/handovers/${h.id}/verify`, { note: 'ok' });
    await loser.client.post(`/handovers/${h.id}/complete`);
    await finder.client.post(`/handovers/${h.id}/complete`);
    expect((await loser.client.get(`/posts/${lost.id}`)).body.status).toBe('RETURNED');
    expect((await loser.client.get(`/posts/${found.id}`)).body.status).toBe('RETURNED');
  });
});

describe('신고', () => {
  it('글·댓글·메시지·사용자 신고는 snapshot 과 함께 저장되고 중복 신고는 409', async () => {
    const a = await signup(env.app);
    const b = await signup(env.app);
    const post = (await makePost(a.client)).body;
    const comment = (await b.client.post(`/posts/${post.id}/comments`, { body: '문제 댓글' })).body.comment;
    const conv = (await a.client.post('/conversations', { targetUserId: b.user.id, body: '불쾌한 쪽지' })).body;
    const r1 = await b.client.post('/reports', { targetType: 'POST', targetId: post.id, reason: 'SPAM' });
    expect(r1.status).toBe(201);
    expect((await b.client.post('/reports', { targetType: 'POST', targetId: post.id, reason: 'SPAM' })).body.error.code).toBe('ALREADY_REPORTED');
    expect((await a.client.post('/reports', { targetType: 'COMMENT', targetId: comment.id, reason: 'HARASSMENT', detail: '욕설' })).status).toBe(201);
    expect((await b.client.post('/reports', { targetType: 'MESSAGE', targetId: conv.message.id, reason: 'HARASSMENT' })).status).toBe(201);
    expect((await b.client.post('/reports', { targetType: 'USER', targetId: a.user.id, reason: 'FAKE' })).status).toBe(201);
    const rows = await env.db.execute<{ target_type: string; snapshot: Record<string, unknown> }>(sql`select target_type, snapshot from reports order by id`);
    expect(rows.rows).toHaveLength(4);
    expect(rows.rows[1]!.snapshot).toMatchObject({ body: '문제 댓글' });
    expect(JSON.stringify(rows.rows[2]!.snapshot)).toContain('불쾌한 쪽지');
  });

  it('대화 참여자가 아니면 메시지를 신고할 수 없다, 잘못된 사유/대상은 400/404', async () => {
    const a = await signup(env.app);
    const b = await signup(env.app);
    const c = await signup(env.app);
    const conv = (await a.client.post('/conversations', { targetUserId: b.user.id, body: '비밀' })).body;
    expect((await c.client.post('/reports', { targetType: 'MESSAGE', targetId: conv.message.id, reason: 'SPAM' })).status).toBe(404);
    expect((await c.client.post('/reports', { targetType: 'POST', targetId: 9999, reason: 'SPAM' })).status).toBe(404);
    expect((await c.client.post('/reports', { targetType: 'POST', targetId: 1, reason: 'NOPE' })).status).toBe(400);
  });
});

describe('API 계약(OpenAPI) 일치', () => {
  it('openapi.yaml 에 정의된 모든 경로·메서드가 서버에 등록되어 있다', async () => {
    const { readFileSync } = await import('node:fs');
    const { parse } = await import('yaml');
    const doc = parse(readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8')) as { paths: Record<string, Record<string, unknown>> };
    const missing: string[] = [];
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const method of Object.keys(ops)) {
        if (!['get', 'post', 'patch', 'delete', 'put'].includes(method)) continue;
        const url = '/api/v1' + path.replace(/\{(\w+)\}/g, ':$1');
        if (!env.app.hasRoute({ method: method.toUpperCase() as 'GET', url })) missing.push(`${method.toUpperCase()} ${path}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('오류 응답은 항상 {error:{code,message}} 형식이고 스택/내부 정보를 노출하지 않는다', async () => {
    const c = new Client(env.app);
    for (const r of [await c.get('/me'), await c.get('/nope'), await c.post('/auth/login', {})]) {
      expect(r.body.error).toEqual(expect.objectContaining({ code: expect.any(String), message: expect.any(String) }));
      expect(JSON.stringify(r.body)).not.toMatch(/stack|node_modules|drizzle|SELECT/i);
    }
  });
});

describe('건물 필터·실제 HTTP 업로드', () => {
  it('buildingId 로 건물 전체를 필터링한다', async () => {
    const { client } = await signup(env.app);
    const locs = (await client.get('/locations')).body.items as { id: number; buildingId: string }[];
    const b1 = locs[0]!;
    await makePost(client, { locationId: b1.id, title: 'A' });
    await makePost(client, { locationId: b1.id, title: 'B' });
    const other = locs.find((l) => l.buildingId !== b1.buildingId && l.buildingId !== 'etc')!;
    await makePost(client, { locationId: other.id, title: '다른 건물' });
    const r = await client.get(`/posts?buildingId=${b1.buildingId}`);
    expect(r.body.items.map((p: { title: string }) => p.title).sort()).toEqual(['A', 'B']);
    expect((await client.get(`/posts?buildingId=${other.buildingId}&locationId=${b1.id}`)).body.items).toEqual([]);
  });

  it('실제 HTTP 서버에 fetch+FormData 로 업로드(쿠키 포함)하고 URL 로 내려받는다', async () => {
    const { client } = await signup(env.app);
    const addr = await env.app.listen({ port: 0, host: '127.0.0.1' });
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(await jpeg(300, 200))], { type: 'image/jpeg' }), 'photo.jpg');
    const up = await fetch(`${addr}/api/v1/photos`, { method: 'POST', body: form, headers: { cookie: client.cookie, origin: 'http://localhost:3000' } });
    expect(up.status).toBe(201);
    const body = (await up.json()) as { url: string; width: number };
    expect(body.width).toBe(300);
    const dl = await fetch(`${addr}${body.url}`, { headers: { cookie: client.cookie } });
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toContain('image/jpeg');
    const noAuth = await fetch(`${addr}/api/v1/photos`, { method: 'POST', body: form });
    expect(noAuth.status).toBe(401);
  });
});

describe('후보 동점 처리', () => {
  it('점수가 같은 후보는 최신 글이 먼저 평가·저장된다(오래된 글이 top-N 을 독점하지 않음)', async () => {
    const finderOld = await signup(env.app);
    const finderNew = await signup(env.app);
    const loser = await signup(env.app);
    const oldFound = (await makePost(finderOld.client, { type: 'FOUND', tags: ['이어폰', '검정'] })).body;
    const newFound = (await makePost(finderNew.client, { type: 'FOUND', tags: ['이어폰', '검정'] })).body;
    await makePost(loser.client, { type: 'LOST', tags: ['이어폰', '검정'] });
    // topN=1 이어도 동점이면 최신 글이 상위
    // 습득글 작업은 건너뛰고(DONE) 분실글 작업만 실행해 후보 순서만 검증한다
    await env.db.execute(sql`update jobs set status = 'DONE' where id in (select id from jobs order by id limit 2)`);
    useHandler(createMatchingEngine({ client: null, config: loadMatchingConfig({ MATCH_TOP_N: '1' }) }), false);
    while (await runNextJob(env.db));
    const saved = await env.db.select().from(schema.matches).orderBy(schema.matches.id);
    expect(saved.map((m) => m.foundPostId)).toEqual([newFound.id, oldFound.id]);
  });
});
