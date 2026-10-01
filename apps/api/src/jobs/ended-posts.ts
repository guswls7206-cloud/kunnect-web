import { and, inArray, isNotNull, lt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { schema } from '../db/client.js';
import { bumpCounter, clearCounter, safeErrorMessage } from '../lib/db-counters.js';
import type { PhotoStorage } from '../storage/index.js';
import { defaultDeletePosts, type PostDeleter } from './post-deleter.js';

/** 종료된 글 보관 시간(종료 후 24시간) [사용자 결정 A17] */
export const ENDED_POST_TTL_MS = 24 * 3600_000;
const BATCH = 200;
const LEASE_KEY = 'cleanup:ended-posts:lease';
const LEASE_MS = 10 * 60_000;

export interface EndedPostsOptions {
  now?: Date;
  /** 기본 24시간. 테스트에서 줄일 수 있다 */
  endedPostTtlMs?: number;
  /** 글 삭제 구현(기본: 파일 삭제 + 글 삭제). 공용 hardDeletePosts 로 교체한다 */
  deletePosts?: PostDeleter;
  log?: (msg: string) => void;
}

export interface EndedPostsReport {
  purgedPosts: number;
  /** 실패 메시지(던지지 않고 보고한다) */
  errors: string[];
  /** 같은 작업이 이미 진행 중이어서 건너뜀 */
  skipped: boolean;
}

/**
 * 종료된 글(CLOSED, 그리고 [가정/제안] RETURNED)을 종료 시각(closed_at) 24시간 뒤에 삭제한다.
 * 정밀도가 필요해 6시간 작업과 별도로 자주(기본 30분) 실행한다. 6시간 작업과 임대(lease)가 분리되어 서로 막지 않고,
 * 같은 작업끼리는 중복 실행되지 않는다. 200건씩 배치로 처리하고 실패는 errors 로 보고한다.
 * closed_at 이 없는 종료 글(비정상 데이터)과 OPEN/MATCHED 글은 건드리지 않는다.
 */
export async function runEndedPostsCleanup(db: Db, storage: PhotoStorage, opts: EndedPostsOptions = {}): Promise<EndedPostsReport> {
  const now = opts.now ?? new Date();
  const report: EndedPostsReport = { purgedPosts: 0, errors: [], skipped: false };
  const lease = await bumpCounter(db, LEASE_KEY, LEASE_MS).catch(() => null);
  if (lease && lease.count > 1) {
    report.skipped = true;
    return report;
  }
  try {
    const cutoff = new Date(now.getTime() - (opts.endedPostTtlMs ?? ENDED_POST_TTL_MS));
    const remove = opts.deletePosts ?? defaultDeletePosts;
    for (;;) {
      const ids = (
        await db
          .select({ id: schema.posts.id })
          .from(schema.posts)
          .where(and(inArray(schema.posts.status, ['CLOSED', 'RETURNED']), isNotNull(schema.posts.closedAt), lt(schema.posts.closedAt, cutoff)))
          .limit(BATCH)
      ).map((r) => r.id);
      if (!ids.length) break;
      await remove(db, storage, ids);
      report.purgedPosts += ids.length;
      opts.log?.(`종료된 글 ${ids.length}건 삭제(누적 ${report.purgedPosts}건)`);
      if (ids.length < BATCH) break;
    }
  } catch (e) {
    report.errors.push(`endedPosts: ${safeErrorMessage(e)}`);
  } finally {
    await clearCounter(db, LEASE_KEY).catch(() => undefined);
  }
  return report;
}

/** 종료된 글 삭제 주기 실행(기본 30분). 첫 실행은 initialDelayMs 뒤. 반환값은 중지 함수(진행 중 실행이 끝날 때까지 기다린다). */
export function startEndedPostsSchedule(
  db: Db,
  storage: PhotoStorage,
  opts: EndedPostsOptions,
  intervalMs = 30 * 60_000,
  log?: (msg: string) => void,
  initialDelayMs = 10_000,
): () => Promise<void> {
  let inflight: Promise<void> = Promise.resolve();
  let stopped = false;
  const run = () => {
    if (stopped) return;
    inflight = runEndedPostsCleanup(db, storage, { ...opts, log })
      .then((r) => log?.(`종료된 글 정리 ${r.skipped ? '건너뜀(다른 실행 진행 중)' : '완료'}: ${JSON.stringify(r)}`))
      .catch((e) => log?.(`종료된 글 정리 실패: ${safeErrorMessage(e)}`));
  };
  const first = setTimeout(run, initialDelayMs);
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return async () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(timer);
    await inflight;
  };
}
