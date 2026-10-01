import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import { schema } from '../src/db/client.js';
import { runCleanup } from '../src/jobs/cleanup.js';
import { createMatchHandler } from '../src/jobs/match-handler.js';
import { DbCounterStore } from '../src/lib/db-counters.js';
import { maskContacts } from '../src/lib/contact-mask.js';
import { prepareImageForAi } from '../src/matching/image.js';
import { loadMatchingConfig } from '../src/matching/index.js';
import type { MatchingEngine } from '../src/matching/types.js';
import { LocalDiskStorage } from '../src/storage/index.js';
import { Client, firstLocationId, jpeg, makePost, setupEnv, signup, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => (env = await setupEnv()));
afterAll(async () => env.close());
beforeEach(async () => env.reset());

describe('DB 카운터 저장소(AI 일일 상한)', () => {
  it('tryConsume 은 원자적이다: 동시 50회 요청에도 상한 20 을 넘지 않는다', async () => {
    const store = new DbCounterStore(env.db);
    const results = await Promise.all(Array.from({ length: 50 }, () => store.tryConsume('2026-10-01', 1, 20)));
    expect(results.filter((r) => r.ok)).toHaveLength(20);
    expect(await store.count('2026-10-01')).toBe(20);
    expect(await store.tryConsume('2026-10-01', 1, 20)).toEqual({ ok: false, count: 20 });
    // 날짜별 독립, 읽기 전용 count, 상한 초과 요청은 변경 없음
    expect(await store.count('2026-10-02')).toBe(0);
    expect(await store.tryConsume('2026-10-02', 25, 20)).toEqual({ ok: false, count: 0 });
    expect(await store.tryConsume('2026-10-02', 5, 20)).toEqual({ ok: true, count: 5 });
  });

  it('재시작(새 인스턴스) 후에도 카운트가 유지된다', async () => {
    await new DbCounterStore(env.db).tryConsume('2026-10-03', 3, 10);
    expect(await new DbCounterStore(env.db).count('2026-10-03')).toBe(3);
  });
});

describe('영속 레이트 리밋 / 로그인 잠금', () => {
  it('서로 다른 서버 인스턴스가 같은 카운터를 공유한다(가입 5회/시간)', async () => {
    const a = await setupEnv({ rateLimitEnabled: true });
    const b = await setupEnv({ rateLimitEnabled: true });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 7; i++) {
        const target = i % 2 === 0 ? a : b;
        codes.push((await new Client(target.app).post('/auth/signup', { loginId: `shared_${i}`, password: 'Test-Pass-77', nickname: `공유${i}` })).status);
      }
      expect(codes.slice(0, 5).every((c) => c === 201)).toBe(true);
      expect(codes.slice(5)).toEqual([429, 429]);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('로그인 잠금은 재시작 후에도 유지되고, IP 를 바꿔도 아이디 단독 한도(30회)에서 잠긴다, 성공하면 IP 카운터 해제', async () => {
    process.env.TEST_LOGIN_LOCK = '1';
    const first = await setupEnv();
    let second: TestEnv | null = null;
    try {
      await signup(first.app, 'persistlock');
      const attempt = (app: TestEnv['app'], i: number, ip: string) =>
        new Client(app).req('POST', '/auth/login', { loginId: 'persistlock', password: 'wrong-pass-1' }, { 'x-forwarded-for': ip, 'x-test': String(i) });
      for (let i = 0; i < 5; i++) expect((await attempt(first.app, i, '1.1.1.1')).status).toBe(401);
      expect((await attempt(first.app, 5, '1.1.1.1')).status).toBe(429);
      // "재시작": 같은 DB 에 새 앱 인스턴스 — 잠금 유지(기본 trustProxy 비활성이라 모두 같은 소켓 IP)
      second = await setupEnv();
      expect((await attempt(second.app, 6, '1.1.1.1')).status).toBe(429);
      // 올바른 비밀번호도 잠금 중에는 거부된다
      expect((await new Client(second.app).post('/auth/login', { loginId: 'persistlock', password: 'Test-Pass-77' })).status).toBe(429);
      // 아이디 단독 한도: 서로 다른 소켓 IP 를 흉내 내기 위해 카운터를 직접 조작해 29→30 확인
      await env.db.execute(sql`delete from rate_counters`);
      await env.db.execute(sql`insert into rate_counters (key, count, expires_at) values ('lf:id:persistlock', 29, now() + interval '5 minutes')`);
      expect((await attempt(second.app, 7, '9.9.9.9')).status).toBe(401); // 30번째 실패 기록
      expect((await attempt(second.app, 8, '9.9.9.9')).status).toBe(429); // 이후 어떤 IP 든 잠김
    } finally {
      delete process.env.TEST_LOGIN_LOCK;
      await first.close();
      if (second) await second.close();
    }
  });

  it('만료된 카운터는 정리 작업이 삭제하고 유효한 카운터는 유지한다', async () => {
    await env.db.execute(sql`insert into rate_counters (key, count, expires_at) values ('old', 1, now() - interval '1 minute'), ('live', 1, now() + interval '5 minutes')`);
    const report = await runCleanup(env.db, new LocalDiskStorage(env.storageDir), { postRetentionDays: 90, dmRetentionDays: 30 });
    expect(report.expiredCounters).toBe(1);
    const left = await env.db.execute<{ key: string }>(sql`select key from rate_counters`);
    expect(left.rows.map((r) => r.key)).toEqual(['live']);
  });
});

describe('TRUST_PROXY_HOPS 의미 (감사 F3)', () => {
  it('HOPS=1 이면 프록시가 덧붙인 마지막 XFF 값만 신뢰한다: 클라이언트가 앞에 위조한 값을 바꿔도 잠금을 우회할 수 없다', async () => {
    process.env.TEST_LOGIN_LOCK = '1';
    const proxied = await setupEnv({ config: { TRUST_PROXY_HOPS: 1 } });
    try {
      await signup(proxied.app, 'hopuser1');
      const codes: number[] = [];
      for (let i = 0; i < 8; i++) {
        // "<위조값>, <프록시가 본 실제 클라이언트 IP>" — 프록시가 실제 IP 를 마지막에 덧붙인 상황
        codes.push((await new Client(proxied.app).req('POST', '/auth/login', { loginId: 'hopuser1', password: 'wrong-pass-1' }, { 'x-forwarded-for': `forged-${i}, 203.0.113.9` })).status);
      }
      expect(codes.slice(0, 5).every((c) => c === 401)).toBe(true);
      expect(codes.slice(5).every((c) => c === 429)).toBe(true);
      // 다른 실제 클라이언트(다른 IP)는 같은 아이디라도 IP+아이디 잠금에 걸리지 않는다
      const other = await new Client(proxied.app).req('POST', '/auth/login', { loginId: 'hopuser1', password: 'Test-Pass-77' }, { 'x-forwarded-for': 'x, 198.51.100.7' });
      expect(other.status).toBe(200);
    } finally {
      delete process.env.TEST_LOGIN_LOCK;
      await proxied.reset();
      await proxied.close();
    }
  });
});

describe('사진 경합 (감사 #8)', () => {
  it('같은 사진을 두 글에 동시에 붙이려 해도 한 글만 성공한다', async () => {
    const { client } = await signup(env.app);
    const photoId = (await client.upload(await jpeg())).body.photoId;
    const results = await Promise.all([makePost(client, { photoIds: [photoId], title: 'A' }), makePost(client, { photoIds: [photoId], title: 'B' })]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
    const rows = await env.db.execute<{ c: number }>(sql`select count(distinct post_id)::int as c from post_photos where id = ${photoId} and post_id is not null`);
    expect(rows.rows[0]!.c).toBe(1);
    const orphanPosts = await env.db.execute<{ c: number }>(sql`select count(*)::int as c from posts`);
    expect(orphanPosts.rows[0]!.c).toBe(1); // 실패한 요청의 글은 롤백
  });

  it('동시 업로드 25건에도 임시 사진은 20장을 넘지 않는다', async () => {
    const { client } = await signup(env.app);
    const img = await jpeg(40, 40);
    const results = await Promise.all(Array.from({ length: 25 }, () => client.upload(img)));
    const ok = results.filter((r) => r.status === 201).length;
    expect(ok).toBeLessThanOrEqual(20);
    expect(ok).toBeGreaterThan(0);
    const c = await env.db.execute<{ c: number }>(sql`select count(*)::int as c from post_photos`);
    expect(c.rows[0]!.c).toBe(ok);
  });
});

describe('연락처 마스킹 (감사 F10)', () => {
  it('ZWJ(U+200D) 이모지 결합 문자는 제거하지 않는다', () => {
    const family = '👨‍👩‍👧';
    expect(maskContacts(`가족 ${family} 사진`).text).toBe(`가족 ${family} 사진`);
    expect(maskContacts('0​1​0-1234-5678').masked).toBe(true); // ZWSP 는 여전히 제거
  });
});

describe('보안: 오류 로그에 쿼리 파라미터가 남지 않는다', () => {
  it('safeErrorMessage 는 Drizzle 오류의 파라미터(개인정보)를 제거한다', async () => {
    const { safeErrorMessage } = await import('../src/lib/db-counters.js');
    let caught: unknown;
    try {
      await env.db.execute(sql`insert into users (login_id, password_hash, nickname, nickname_lower) values (${'leak_login'}, ${'SECRET-HASH-VALUE'}, ${null}, ${'x'})`);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    const msg = safeErrorMessage(caught);
    expect(msg).not.toContain('SECRET-HASH-VALUE');
    expect(msg).not.toContain('leak_login');
  });
});

describe('매칭 작업 성능: AI 사본 캐시 + 동시 로딩', () => {
  const N = 50;

  async function seedCandidates() {
    const finder = await signup(env.app);
    const loser = await signup(env.app);
    const locationId = await firstLocationId(finder.client);
    // 실제 사진처럼 크기가 큰(1600x1200 노이즈) JPEG
    const big = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#808080', noise: { type: 'gaussian', mean: 128, sigma: 40 } } }).jpeg({ quality: 85 }).toBuffer();
    const storage = new LocalDiskStorage(env.storageDir);
    for (let i = 0; i < N; i++) {
      const [p] = await env.db
        .insert(schema.posts)
        .values({ type: 'FOUND', authorId: finder.user.id, title: `후보 ${i}`, description: '설명', locationId, occurredAt: new Date(Date.now() - 3600_000), storagePlace: '보관', matchState: 'DONE' })
        .returning();
      const key = `photos/perf-${i}.jpg`;
      const url = await storage.save(key, big);
      await env.db.insert(schema.postPhotos).values({ postId: p!.id, ownerId: finder.user.id, storageKey: key, url, width: 1600, height: 1200 });
    }
    const lostPost = (await makePost(loser.client, { type: 'LOST' })).body;
    const lostKey = 'photos/perf-lost.jpg';
    await env.db.insert(schema.postPhotos).values({ postId: lostPost.id, ownerId: loser.user.id, storageKey: lostKey, url: await storage.save(lostKey, big), width: 1600, height: 1200 });
    return { lostPost, storage, big };
  }

  it(`후보 ${N}건(각 1600x1200 사진) 처리: 처음엔 사본 생성, 두 번째부터는 캐시 사본만 읽는다`, async () => {
    const { lostPost, storage, big } = await seedCandidates();
    const cfg = loadMatchingConfig({});
    let received = 0;
    const engine: MatchingEngine = {
      async extractAttributes(p) {
        return { postId: p.id, photos: [] };
      },
      async matchPair() {
        throw new Error('미사용');
      },
      async rankCandidates(_p, cs) {
        received = cs.filter((c) => c.photos.some((ph) => ph.base64)).length;
        return [];
      },
    };
    const handler = createMatchHandler({ db: env.db, storage, engine, config: cfg });

    // 기준선: 예전 방식(후보 사진을 매번 순차로 읽고 리사이즈)
    const t0 = performance.now();
    for (let i = 0; i < N; i++) await prepareImageForAi(await storage.read(`photos/perf-${i}.jpg`), cfg.image);
    const baselineMs = performance.now() - t0;

    const t1 = performance.now();
    await handler(lostPost.id);
    const coldMs = performance.now() - t1;
    expect(received).toBe(N);
    const cached = await env.db.execute<{ c: number }>(sql`select count(*)::int as c from post_photos where ai_key is not null`);
    expect(cached.rows[0]!.c).toBe(N + 1); // 후보 N + 내 글 1
    const aiKey = (await env.db.execute<{ ai_key: string }>(sql`select ai_key from post_photos where ai_key is not null limit 1`)).rows[0]!.ai_key;
    expect(existsSync(join(env.storageDir, aiKey))).toBe(true);

    const t2 = performance.now();
    await handler(lostPost.id);
    const warmMs = performance.now() - t2;
    expect(received).toBe(N);

    console.log(`[벤치] 후보 ${N}건 | 예전 방식(순차 리사이즈) ${baselineMs.toFixed(0)}ms | 첫 실행(동시 8, 사본 생성) ${coldMs.toFixed(0)}ms | 캐시 후 ${warmMs.toFixed(0)}ms | 원본 ${(big.length / 1024).toFixed(0)}KB`);
    expect(warmMs).toBeLessThan(coldMs);
  });

  it('내 글에 사진이 없으면 후보 이미지를 읽지 않는다', async () => {
    const { storage } = await seedCandidates();
    const loser2 = await signup(env.app);
    const noPhoto = (await makePost(loser2.client, { type: 'LOST' })).body;
    let withImages = -1;
    const engine = {
      async extractAttributes(p: { id: string }) {
        return { postId: p.id, photos: [] };
      },
      async matchPair() {
        throw new Error('미사용');
      },
      async rankCandidates(_p: unknown, cs: { photos: { base64?: string }[] }[]) {
        withImages = cs.filter((c) => c.photos.some((ph) => ph.base64)).length;
        return [];
      },
    } as unknown as MatchingEngine;
    await createMatchHandler({ db: env.db, storage, engine, config: loadMatchingConfig({}) })(noPhoto.id);
    expect(withImages).toBe(0);
    const cached = await env.db.execute<{ c: number }>(sql`select count(*)::int as c from post_photos where ai_key is not null`);
    expect(cached.rows[0]!.c).toBe(0);
  });

  it('정리 작업은 AI 사본 파일을 고아로 오인해 지우지 않고, 글이 삭제되면 사본도 함께 삭제한다', async () => {
    const { lostPost, storage } = await seedCandidates();
    const engine = { async extractAttributes(p: { id: string }) { return { postId: p.id, photos: [] }; }, async matchPair() { throw new Error('x'); }, async rankCandidates() { return []; } } as unknown as MatchingEngine;
    await createMatchHandler({ db: env.db, storage, engine, config: loadMatchingConfig({}) })(lostPost.id);
    const keys = (await env.db.execute<{ ai_key: string }>(sql`select ai_key from post_photos where ai_key is not null`)).rows.map((r) => r.ai_key);
    expect(keys.length).toBeGreaterThan(0);
    // 파일 수정 시각을 3일 전으로 만들어 고아 파일 유예(24시간)를 지나게 한다
    const { utimesSync } = await import('node:fs');
    const past = new Date(Date.now() - 3 * 24 * 3600_000);
    for (const k of keys) utimesSync(join(env.storageDir, k), past, past);
    const report = await runCleanup(env.db, storage, { postRetentionDays: 90, dmRetentionDays: 30 });
    expect(report.orphanFiles).toBe(0);
    expect(keys.every((k) => existsSync(join(env.storageDir, k)))).toBe(true);
    // 글을 오래전에 종료 처리하면 원본과 사본이 함께 삭제된다
    await env.db.execute(sql`update posts set status = 'CLOSED', closed_at = now() - interval '100 days' where id = ${lostPost.id}`);
    await runCleanup(env.db, storage, { postRetentionDays: 90, dmRetentionDays: 30 });
    const lostKey = (await env.db.execute<{ c: number }>(sql`select count(*)::int as c from post_photos where post_id = ${lostPost.id}`)).rows[0]!.c;
    expect(lostKey).toBe(0);
  });
});
