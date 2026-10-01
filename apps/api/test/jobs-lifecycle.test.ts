import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { recoverStaleJobs, runNextJob, setMatchHandler, startWorker } from '../src/jobs/queue.js';
import { makePost, setupEnv, signup, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => (env = await setupEnv()));
afterAll(async () => env.close());
beforeEach(async () => {
  setMatchHandler(null);
  await env.reset();
});

const rows = async <T>(q: ReturnType<typeof sql>) => (await env.db.execute<T & Record<string, unknown>>(q)).rows;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function postWithJob() {
  const u = await signup(env.app);
  const post = (await makePost(u.client)).body; // 글 등록이 MATCH_POST 작업을 큐에 넣는다
  return post.id as number;
}

describe('M2: 멈춘 작업이 FAILED 로 확정되면 글 matchState 도 FAILED', () => {
  it('시도 횟수 상한에 도달한 RUNNING 작업을 복구하면 글이 PENDING 에 머물지 않는다', async () => {
    const postId = await postWithJob();
    await env.db.execute(sql`update jobs set status = 'RUNNING', attempts = 3, started_at = now() - interval '30 minutes'`);
    expect(await recoverStaleJobs(env.db)).toBe(1);
    const [j] = await rows<{ status: string }>(sql`select status from jobs`);
    expect(j!.status).toBe('FAILED');
    const [p] = await rows<{ match_state: string }>(sql`select match_state from posts where id = ${postId}`);
    expect(p!.match_state).toBe('FAILED');
  });
  it('재시도 가능한 작업은 QUEUED 로 되돌리고 글 상태는 유지', async () => {
    const postId = await postWithJob();
    await env.db.execute(sql`update jobs set status = 'RUNNING', attempts = 1, started_at = now() - interval '30 minutes'`);
    await recoverStaleJobs(env.db);
    const [p] = await rows<{ match_state: string }>(sql`select match_state from posts where id = ${postId}`);
    expect(p!.match_state).toBe('PENDING');
  });
});

describe('M3: 핸들러 타임아웃', () => {
  it('핸들러가 시간 안에 끝나지 않으면 작업은 재시도 대기(QUEUED)로 돌아가고 워커는 막히지 않는다', async () => {
    await postWithJob();
    setMatchHandler(() => new Promise(() => undefined)); // 영원히 끝나지 않음
    const started = Date.now();
    expect(await runNextJob(env.db, { timeoutMs: 150 })).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
    const [j] = await rows<{ status: string; last_error: string; attempts: number }>(sql`select status, last_error, attempts from jobs`);
    expect(j!.status).toBe('QUEUED');
    expect(j!.attempts).toBe(1);
    expect(j!.last_error).toContain('시간');
  });
});

describe('H-D/H-F: 워커 수명 주기', () => {
  it('stop() 은 진행 중인 작업이 끝날 때까지 기다린다', async () => {
    await postWithJob();
    let finished = false;
    setMatchHandler(async () => {
      await sleep(400);
      finished = true;
    });
    const w = startWorker(env.db, { intervalMs: 20, recoverEveryMs: 60_000 });
    await sleep(150); // 작업이 시작되어 진행 중
    await w.stop();
    expect(finished).toBe(true);
    const [j] = await rows<{ status: string }>(sql`select status from jobs`);
    expect(j!.status).toBe('DONE');
  });
  it('stop() 이후에는 새 작업을 집어 가지 않는다', async () => {
    const w = startWorker(env.db, { intervalMs: 20, recoverEveryMs: 60_000 });
    setMatchHandler(async () => undefined);
    await w.stop();
    await postWithJob();
    await sleep(150);
    const [j] = await rows<{ status: string }>(sql`select status from jobs`);
    expect(j!.status).toBe('QUEUED');
  });
  it('H-F: 워커가 주기적으로 멈춘 RUNNING 작업을 복구한다(재기동 직후 어린 작업도 시간이 지나면)', async () => {
    await postWithJob();
    setMatchHandler(null); // 처리는 하지 않고 복구만 관찰
    await env.db.execute(sql`update jobs set status = 'RUNNING', attempts = 1, started_at = now() - interval '2 seconds'`);
    const w = startWorker(env.db, { intervalMs: 50, recoverEveryMs: 80, staleAfterMs: 1000 });
    await sleep(700);
    await w.stop();
    const [j] = await rows<{ status: string }>(sql`select status from jobs`);
    expect(j!.status).toBe('QUEUED');
  });
  it('M4: 처리 중 예외는 삼키지 않고 로거로 보고하며 워커는 계속 돈다', async () => {
    const warns: string[] = [];
    await postWithJob();
    setMatchHandler(async () => undefined);
    // jobs 테이블 접근 오류를 모사: 존재하지 않는 DB 객체를 쓰는 대신 db.execute 를 한 번 실패시킨다
    const realExecute = env.db.execute.bind(env.db);
    let failed = false;
    (env.db as unknown as { execute: unknown }).execute = (...a: unknown[]) => {
      if (!failed) {
        failed = true;
        return Promise.reject(new Error('boom-db'));
      }
      return (realExecute as (...x: unknown[]) => unknown)(...a);
    };
    const w = startWorker(env.db, { intervalMs: 20, recoverEveryMs: 60_000, logger: { warn: (m) => warns.push(m) } });
    await sleep(500);
    await w.stop();
    (env.db as unknown as { execute: unknown }).execute = realExecute;
    expect(warns.length).toBeGreaterThan(0);
    const [j] = await rows<{ status: string }>(sql`select status from jobs`);
    expect(j!.status).toBe('DONE'); // 오류 후에도 다음 틱에서 처리됨
  });
});
