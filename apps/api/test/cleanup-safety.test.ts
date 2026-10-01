import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { runCleanup, startCleanupSchedule } from '../src/jobs/cleanup.js';
import { LocalDiskStorage, type PhotoStorage } from '../src/storage/index.js';
import { jpeg, makePost, setupEnv, signup, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => (env = await setupEnv()));
afterAll(async () => env.close());
beforeEach(async () => {
  for (const n of readdirSync(env.storageDir)) rmSync(join(env.storageDir, n), { recursive: true, force: true }); // 테스트 간 저장소 파일 격리
  await env.reset();
  await env.db.execute(sql`delete from rate_counters`);
});

const opts = { postRetentionDays: 90, dmRetentionDays: 30 };
const rows = async <T>(q: ReturnType<typeof sql>) => (await env.db.execute<T & Record<string, unknown>>(q)).rows;
const old = new Date(Date.now() - 3 * 24 * 3600_000);

function putFile(key: string, mtime = old) {
  const full = join(env.storageDir, key);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, 'x');
  utimesSync(full, mtime, mtime);
  return full;
}

/** 사진이 DB 에 연결된 글 1건(고아 판정 대조군) */
async function postWithPhoto() {
  const u = await signup(env.app);
  const up = await u.client.upload(await jpeg());
  const post = (await makePost(u.client, { photoIds: [up.body.photoId] })).body;
  return { post, photo: up.body };
}

describe('M16: 고아 파일 정리 안전장치', () => {
  it('photos/·ai/ 접두사만 정리하고 그 밖의 파일은 오래돼도 건드리지 않는다', async () => {
    await postWithPhoto();
    const orphan = putFile('photos/orphan-aaaa.jpg');
    const aiOrphan = putFile('ai/orphan-bbbb.jpg');
    const other = putFile('other/keep-me.txt');
    const rootFile = putFile('README-important.txt');
    const report = await runCleanup(env.db, new LocalDiskStorage(env.storageDir), opts);
    expect(report.orphanFiles).toBe(2);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(aiOrphan)).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(rootFile)).toBe(true);
  });

  it('DB 와 연결된 파일(원본/AI 사본)은 오래돼도 지우지 않는다', async () => {
    const { photo } = await postWithPhoto();
    const [p] = await rows<{ storage_key: string }>(sql`select storage_key from post_photos where id = ${photo.photoId}`);
    const full = join(env.storageDir, p!.storage_key);
    utimesSync(full, old, old);
    putFile('photos/orphan-cccc.jpg');
    const report = await runCleanup(env.db, new LocalDiskStorage(env.storageDir), opts);
    expect(report.orphanFiles).toBe(1);
    expect(existsSync(full)).toBe(true);
  });

  it('한 번에 지우는 고아 파일은 상한(maxOrphanDeletes)까지만, 나머지는 다음 실행에서', async () => {
    await postWithPhoto();
    for (let i = 0; i < 12; i++) putFile(`photos/o${i}.jpg`);
    const storage = new LocalDiskStorage(env.storageDir);
    const logs: string[] = [];
    const r1 = await runCleanup(env.db, storage, { ...opts, maxOrphanDeletes: 5, log: (m) => logs.push(m) });
    expect(r1.orphanFiles).toBe(5);
    expect(logs.some((m) => m.includes('고아 파일 5건 삭제 예정(후보 12건'))).toBe(true); // 삭제 전에 건수를 남긴다
    const r2 = await runCleanup(env.db, storage, { ...opts, maxOrphanDeletes: 100 });
    expect(r2.orphanFiles).toBe(7);
  });

  it('와이프 방지: DB 에 사진 행이 없는데 고아 후보가 많으면(DB 초기화/경로 오설정 의심) 삭제하지 않고 오류로 보고한다', async () => {
    const files = Array.from({ length: 25 }, (_, i) => putFile(`photos/w${i}.jpg`));
    const report = await runCleanup(env.db, new LocalDiskStorage(env.storageDir), opts);
    expect(report.orphanFiles).toBe(0);
    expect(report.errors.join(' ')).toContain('post_photos 가 비어 있는데');
    expect(files.every((f) => existsSync(f))).toBe(true);
  });

  it('유예(24시간) 안의 파일은 고아여도 지우지 않는다', async () => {
    await postWithPhoto();
    const fresh = putFile('photos/fresh.jpg', new Date());
    const report = await runCleanup(env.db, new LocalDiskStorage(env.storageDir), opts);
    expect(report.orphanFiles).toBe(0);
    expect(existsSync(fresh)).toBe(true);
  });
});

describe('M17: 단계 격리·중복 실행 방지·보존 정책', () => {
  it('저장소 나열이 실패해도 다른 단계(세션·카운터·작업 정리)는 계속 실행되고 오류가 보고된다', async () => {
    await env.db.execute(sql`insert into rate_counters (key, count, expires_at) values ('k', 1, now() - interval '1 hour')`);
    const broken = new Proxy(new LocalDiskStorage(env.storageDir), {
      get(target, prop, recv) {
        if (prop === 'list') return async () => { throw new Error('ENOENT: stat 중 사라짐'); };
        return Reflect.get(target, prop, recv);
      },
    }) as PhotoStorage;
    const report = await runCleanup(env.db, broken, opts);
    expect(report.errors.some((e) => e.startsWith('orphanFiles:'))).toBe(true);
    expect(report.expiredCounters).toBeGreaterThanOrEqual(1); // 뒤 단계가 실행됨
  });

  it('다른 실행이 진행 중이면(임대 보유) 건너뛰고, 끝나면 다시 실행할 수 있다', async () => {
    const slow = new Proxy(new LocalDiskStorage(env.storageDir), {
      get(target, prop, recv) {
        if (prop === 'list') return async () => { await new Promise((r) => setTimeout(r, 400)); return []; };
        return Reflect.get(target, prop, recv);
      },
    }) as PhotoStorage;
    const first = runCleanup(env.db, slow, opts); // 400ms 동안 임대를 쥐고 있다
    await new Promise((r) => setTimeout(r, 150));
    const second = await runCleanup(env.db, new LocalDiskStorage(env.storageDir), opts);
    expect(second.skipped).toBe(true);
    expect((await first).skipped).toBe(false);
    expect((await runCleanup(env.db, new LocalDiskStorage(env.storageDir), opts)).skipped).toBe(false);
  });

  it('30일 지난 FAILED 작업과 60일 지난 AI 일일 카운터를 정리하고 최근 것은 유지', async () => {
    await env.db.execute(sql`insert into jobs (type, payload, status, created_at) values
      ('MATCH_POST', '{"postId":1}', 'FAILED', now() - interval '40 days'),
      ('MATCH_POST', '{"postId":2}', 'FAILED', now() - interval '2 days')`);
    await env.db.execute(sql`insert into ai_call_counters (day, n) values ('2020-01-01', 5), (to_char(now() + interval '9 hours', 'YYYY-MM-DD'), 1)`);
    const report = await runCleanup(env.db, new LocalDiskStorage(env.storageDir), opts);
    expect(report.failedJobs).toBe(1);
    expect(report.aiCounters).toBe(1);
    expect(await rows(sql`select 1 from jobs`)).toHaveLength(1);
    expect(await rows(sql`select 1 from ai_call_counters`)).toHaveLength(1);
  });

  it('startCleanupSchedule 의 중지 함수는 진행 중인 실행이 끝날 때까지 기다린다', async () => {
    let released = false;
    const slow = new Proxy(new LocalDiskStorage(env.storageDir), {
      get(target, prop, recv) {
        if (prop === 'list') return async () => { await new Promise((r) => setTimeout(r, 300)); released = true; return []; };
        return Reflect.get(target, prop, recv);
      },
    }) as PhotoStorage;
    putFile('photos/trigger.jpg'); // list 가 호출되도록 임시 사진이 없어도 단계 5 는 항상 list 를 호출한다
    const stop = startCleanupSchedule(env.db, slow, opts, 60_000);
    await new Promise((r) => setTimeout(r, 5_200)); // 첫 실행(5초 후) 시작
    await stop();
    expect(released).toBe(true);
  }, 15_000);
});

describe('M17: 저장소 원자성·오류 처리', () => {
  it('save 는 임시 파일을 남기지 않고 내용을 그대로 저장한다', async () => {
    const storage = new LocalDiskStorage(env.storageDir);
    await storage.save('photos/atomic.jpg', Buffer.from('hello'));
    expect(readdirSync(join(env.storageDir, 'photos')).filter((n) => n.includes('.tmp-'))).toEqual([]);
    expect((await storage.read('photos/atomic.jpg')).toString()).toBe('hello');
  });
  it('save 실패(디렉터리가 있는 키) 시 임시 파일을 정리하고 오류를 던진다', async () => {
    const storage = new LocalDiskStorage(env.storageDir);
    mkdirSync(join(env.storageDir, 'photos/dir-as-file.jpg'), { recursive: true });
    await expect(storage.save('photos/dir-as-file.jpg', Buffer.from('x'))).rejects.toThrow();
    expect(readdirSync(join(env.storageDir, 'photos')).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });
  it('delete: 없는 파일(ENOENT)은 조용히, 그 밖의 오류는 기록하되 던지지 않는다', async () => {
    const warns: string[] = [];
    const storage = new LocalDiskStorage(env.storageDir, { warn: (m) => warns.push(m) });
    await storage.delete('photos/nope.jpg');
    expect(warns).toEqual([]);
    mkdirSync(join(env.storageDir, 'photos/a-directory'), { recursive: true });
    await storage.delete('photos/a-directory'); // unlink 가 EISDIR/EPERM 으로 실패
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain('파일 삭제 실패');
  });
  it('list(prefixes) 는 접두사만 반환하고, 경로 이탈 키는 거부한다', async () => {
    putFile('photos/p.jpg');
    putFile('ai/a.jpg');
    putFile('other/o.txt');
    const storage = new LocalDiskStorage(env.storageDir);
    expect((await storage.list({ prefixes: ['photos/'] })).map((f) => f.key)).toEqual(['photos/p.jpg']);
    expect((await storage.list()).length).toBe(3);
    await expect(storage.read('../outside.txt')).rejects.toThrow('잘못된 저장 경로');
  });
});
