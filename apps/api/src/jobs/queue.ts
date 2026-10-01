import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { schema } from '../db/client.js';
import { safeErrorMessage } from '../lib/db-counters.js';

/**
 * 프로세스 내 작업 큐(DB jobs 테이블 기반, Redis 없음).
 * 매칭 엔진(src/matching)이 준비되면 setMatchHandler 로 핸들러를 연결한다.
 * 핸들러가 없으면 작업은 QUEUED 로 남고 글의 matchState 는 PENDING 으로 유지된다.
 */
export type MatchHandler = (postId: number) => Promise<void>;

let matchHandler: MatchHandler | null = null;

export function setMatchHandler(handler: MatchHandler | null) {
  matchHandler = handler;
}

/** 글 등록/수정 후 호출. 작업 행만 넣고 즉시 반환한다. */
export async function enqueueMatch(db: Db, postId: number): Promise<void> {
  await db.insert(schema.jobs).values({ type: 'MATCH_POST', payload: { postId } });
  await db.update(schema.posts).set({ matchState: 'PENDING' }).where(eq(schema.posts.id, postId));
}

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [2000, 8000, 30000];
/** 핸들러 1건 제한 시간. 반드시 STALE_AFTER_MS 보다 짧아야 한다(느린 작업이 "멈춘 작업"으로 오인되어 중복 실행되지 않게). */
export const JOB_TIMEOUT_MS = 120_000;
/** 이 시간 넘게 RUNNING 이면 멈춘 작업으로 본다 */
export const STALE_AFTER_MS = 10 * 60_000;

export interface JobLogger {
  warn(message: string, err?: unknown): void;
}
const noopLogger: JobLogger = { warn: () => undefined };

export interface RunOptions {
  timeoutMs?: number;
  logger?: JobLogger;
}

/** 시간 초과 시 거부된다. 핸들러 자체는 취소할 수 없어 백그라운드에서 끝까지 실행될 수 있다(결과는 버린다). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`작업 시간 초과(${Math.round(ms / 1000)}초)`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** 대기 중인 작업 1건을 처리한다. 처리했으면 true. (워커 루프/테스트에서 호출) */
export async function runNextJob(db: Db, opts: RunOptions = {}): Promise<boolean> {
  if (!matchHandler) return false;
  const claimed = await db.execute<{ id: number; payload: { postId: number }; attempts: number }>(sql`
    update jobs set status = 'RUNNING', attempts = attempts + 1, started_at = now()
     where id = (select id from jobs where status = 'QUEUED' and run_after <= now() order by id limit 1 for update skip locked)
    returning id, payload, attempts`);
  const job = claimed.rows[0];
  if (!job) return false;
  try {
    await withTimeout(matchHandler(job.payload.postId), opts.timeoutMs ?? JOB_TIMEOUT_MS);
    // 작업 완료와 글 상태 갱신은 한 트랜잭션: 둘 사이에서 실패해 이미 DONE 인 작업이 재큐잉되는 일이 없다
    await db.transaction(async (tx) => {
      await tx.update(schema.jobs).set({ status: 'DONE' }).where(eq(schema.jobs.id, job.id));
      await tx.update(schema.posts).set({ matchState: 'DONE' }).where(eq(schema.posts.id, job.payload.postId));
    });
  } catch (e) {
    const exhausted = job.attempts >= MAX_ATTEMPTS;
    (opts.logger ?? noopLogger).warn(`작업 ${job.id} 실패(시도 ${job.attempts}/${MAX_ATTEMPTS}): ${safeErrorMessage(e)}`);
    await db.transaction(async (tx) => {
      await tx
        .update(schema.jobs)
        .set({
          status: exhausted ? 'FAILED' : 'QUEUED',
          lastError: safeErrorMessage(e),
          runAfter: new Date(Date.now() + (BACKOFF_MS[job.attempts - 1] ?? 30000)),
        })
        .where(eq(schema.jobs.id, job.id));
      if (exhausted) await tx.update(schema.posts).set({ matchState: 'FAILED' }).where(eq(schema.posts.id, job.payload.postId));
    });
  }
  return true;
}

/**
 * 서버 비정상 종료 등으로 RUNNING 에 멈춘 작업을 QUEUED 로 되돌린다(시도 횟수는 유지되어 무한 재시도는 없다).
 * 시도 횟수가 상한에 도달한 작업은 FAILED 로 확정하고 해당 글의 matchState 도 FAILED 로 바꾼다(PENDING 에 영원히 머물지 않게).
 * 처리한 작업 건수를 반환한다.
 */
export async function recoverStaleJobs(db: Db, olderThanMs = STALE_AFTER_MS): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  return db.transaction(async (tx) => {
    const res = await tx.execute<{ status: string; post_id: number | null }>(sql`
      update jobs set status = case when attempts >= ${MAX_ATTEMPTS} then 'FAILED' else 'QUEUED' end,
                      last_error = coalesce(last_error, '작업이 중단되어 복구됨'), run_after = now()
       where status = 'RUNNING' and started_at < ${cutoff}
      returning status, (payload->>'postId')::int as post_id`);
    const failedPostIds = res.rows.filter((r) => r.status === 'FAILED' && r.post_id !== null).map((r) => r.post_id as number);
    if (failedPostIds.length) {
      await tx.execute(sql`update posts set match_state = 'FAILED' where id in (${sql.join(failedPostIds.map((id) => sql`${id}`), sql`, `)})`);
    }
    return res.rowCount ?? res.rows.length;
  });
}

export interface WorkerOptions {
  /** 대기 작업이 없을 때 폴링 간격(기본 1초) */
  intervalMs?: number;
  /** 핸들러 제한 시간(기본 120초) */
  jobTimeoutMs?: number;
  /** 멈춘 작업 복구 주기(기본 1분) */
  recoverEveryMs?: number;
  /** 이 시간보다 오래 RUNNING 이면 멈춘 것으로 본다(기본 10분) */
  staleAfterMs?: number;
  logger?: JobLogger;
}

export interface Worker {
  /** 새 작업 수령을 멈추고 진행 중인 작업이 끝날 때까지 기다린다. */
  stop(): Promise<void>;
}

/** 서버 기동 시 워커 루프 시작. 멈춘 RUNNING 작업은 기동 직후 1회 + 주기적으로 복구한다. */
export function startWorker(db: Db, opts: WorkerOptions = {}): Worker {
  const { intervalMs = 1000, jobTimeoutMs = JOB_TIMEOUT_MS, recoverEveryMs = 60_000, staleAfterMs = STALE_AFTER_MS } = opts;
  const logger = opts.logger ?? noopLogger;
  let stopped = false;
  let inflight: Promise<void> = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;

  const recover = () =>
    recoverStaleJobs(db, staleAfterMs)
      .then((n) => {
        if (n > 0) logger.warn(`멈춘 작업 ${n}건 복구`);
      })
      .catch((e) => logger.warn(`멈춘 작업 복구 실패: ${safeErrorMessage(e)}`));
  void recover();
  const recoverTimer = setInterval(() => void recover(), recoverEveryMs);
  recoverTimer.unref();

  const tick = () => {
    inflight = (async () => {
      try {
        while (!stopped && (await runNextJob(db, { timeoutMs: jobTimeoutMs, logger })));
      } catch (e) {
        logger.warn(`작업 처리 오류: ${safeErrorMessage(e)}`); // 삼키지 않고 보고한 뒤 다음 틱에서 계속
      } finally {
        if (!stopped) timer = setTimeout(tick, intervalMs);
      }
    })();
  };
  timer = setTimeout(tick, intervalMs);

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      clearInterval(recoverTimer);
      await inflight;
    },
  };
}
