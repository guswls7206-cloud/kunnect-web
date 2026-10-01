import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { schema } from '../db/client.js';
import type { PhotoStorage } from '../storage/index.js';
import { bumpCounter, clearCounter, purgeExpiredCounters, safeErrorMessage } from '../lib/db-counters.js';
import { defaultDeletePosts, type PostDeleter } from './post-deleter.js';
import { recoverStaleJobs } from './queue.js';

export { ENDED_POST_TTL_MS, runEndedPostsCleanup, startEndedPostsSchedule, type EndedPostsOptions, type EndedPostsReport } from './ended-posts.js';
export type { PostDeleter } from './post-deleter.js';

const DAY_MS = 24 * 3600_000;
const TEMP_PHOTO_MS = DAY_MS; // 글에 연결되지 않은 임시 사진 보존 시간
const ORPHAN_FILE_MS = DAY_MS; // 방금 업로드되어 DB 반영 전인 파일을 지우지 않기 위한 유예
const BATCH = 200; // 한 번에 읽고 지우는 행 수(긴 잠금·거대한 IN 목록 방지)
const KEY_CHUNK = 500; // 고아 후보를 DB 에 대조하는 단위
/** 고아 파일 정리가 건드리는 키 접두사. 저장소 루트에 다른 파일이 있어도(설정 실수 포함) 지우지 않는다. */
const ORPHAN_PREFIXES = ['photos/', 'ai/'];
/** 한 번 실행에서 지우는 고아 파일 상한 기본값 */
const DEFAULT_MAX_ORPHAN_DELETES = 500;
/** DB 에 사진 행이 하나도 없는데 고아 후보가 이만큼 이상이면 DB 초기화·저장소 경로 오설정을 의심해 정리를 건너뛴다 */
const WIPE_GUARD_MIN_FILES = 20;
const FAILED_JOB_RETENTION_DAYS = 30;
const AI_COUNTER_RETENTION_DAYS = 60;
/** 정리 작업 중복 실행 방지 임대(lease) 시간. 비정상 종료해도 이 시간 뒤 자동 해제된다. */
const LEASE_MS = 30 * 60_000;
const LEASE_KEY = 'cleanup:lease';

export interface CleanupOptions {
  /**
   * 안전망: 종료(closed_at) 후 이 일수(기본 90일)가 지난 글을 6시간 작업에서 삭제한다.
   * 종료된 글의 정상 삭제는 24시간 뒤 별도 작업(runEndedPostsCleanup)이 하므로 이 규칙은 그 작업이 놓친 글을 위한 백스톱이다.
   * OPEN/MATCHED 글(closed_at 없음)은 삭제하지 않는다.
   */
  postRetentionDays: number;
  /**
   * 쪽지 보존 일수 [사용자 결정 U3]: 마지막 메시지로부터 이 일수(기본 30일)가 지나면 대화와 메시지를 삭제한다.
   * 종료(closed_at)·인수 상태와 무관하다(옛 "종료 AND 마지막 메시지" 규칙을 대체).
   */
  dmRetentionDays: number;
  /** 글 삭제 구현 교체 지점(공용 hardDeletePosts 로 대체). 기본은 파일 삭제 + 글 삭제 */
  deletePosts?: PostDeleter;
  now?: Date;
  /** 한 번 실행에서 지우는 고아 파일 상한(기본 500) */
  maxOrphanDeletes?: number;
  /** 삭제 전 건수 등 운영 로그 */
  log?: (msg: string) => void;
}

export interface CleanupReport {
  expiredSessions: number;
  tempPhotos: number;
  purgedPosts: number;
  purgedConversations: number;
  orphanFiles: number;
  recoveredJobs: number;
  expiredCounters: number;
  doneJobs: number;
  failedJobs: number;
  aiCounters: number;
  /** 단계별 실패 메시지(한 단계가 실패해도 나머지는 계속 실행된다) */
  errors: string[];
  /** 다른 실행이 진행 중이어서 건너뜀 */
  skipped: boolean;
}

/**
 * 만료 데이터 정리. 멱등이며 여러 번 실행해도 안전하다.
 * - 중복 실행 방지: DB 임대(lease)를 잡지 못하면 건너뛴다(skipped).
 * - 각 단계는 격리된다: 실패한 단계는 errors 에 기록하고 다음 단계로 진행한다.
 * - 배치 처리: 200건씩 읽고 지워 대량 적체에도 긴 잠금/거대한 IN 목록이 생기지 않는다.
 */
export async function runCleanup(db: Db, storage: PhotoStorage, opts: CleanupOptions): Promise<CleanupReport> {
  const now = opts.now ?? new Date();
  const log = opts.log ?? (() => undefined);
  const report: CleanupReport = {
    expiredSessions: 0, tempPhotos: 0, purgedPosts: 0, purgedConversations: 0, orphanFiles: 0, recoveredJobs: 0,
    expiredCounters: 0, doneJobs: 0, failedJobs: 0, aiCounters: 0, errors: [], skipped: false,
  };

  const lease = await bumpCounter(db, LEASE_KEY, LEASE_MS).catch(() => null);
  if (lease && lease.count > 1) {
    report.skipped = true;
    return report;
  }
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      report.errors.push(`${name}: ${safeErrorMessage(e)}`);
    }
  };

  try {
    // 1) 만료 세션
    await step('sessions', async () => {
      report.expiredSessions = (await db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, now)).returning({ id: schema.sessions.id })).length;
    });

    // 2) 24시간 지난 임시 사진(글에 연결되지 않음): 파일 + 행
    await step('tempPhotos', async () => {
      const cutoff = new Date(now.getTime() - TEMP_PHOTO_MS);
      for (;;) {
        const temp = await db
          .select({ id: schema.postPhotos.id, key: schema.postPhotos.storageKey, aiKey: schema.postPhotos.aiKey, blurredKey: schema.postPhotos.blurredKey })
          .from(schema.postPhotos)
          .where(and(isNull(schema.postPhotos.postId), lt(schema.postPhotos.createdAt, cutoff)))
          .limit(BATCH);
        if (!temp.length) break;
        for (const p of temp) {
          await storage.delete(p.key);
          if (p.aiKey) await storage.delete(p.aiKey);
          if (p.blurredKey) await storage.delete(p.blurredKey);
        }
        await db.delete(schema.postPhotos).where(inArray(schema.postPhotos.id, temp.map((p) => p.id)));
        report.tempPhotos += temp.length;
        if (temp.length < BATCH) break;
      }
    });

    // 3) 종료 후 보존 기간이 지난 글: 사진 파일 삭제 후 글 삭제(댓글·매칭·알림·인수 요청·태그 연결은 FK cascade)
    await step('posts', async () => {
      const postCutoff = new Date(now.getTime() - opts.postRetentionDays * DAY_MS);
      for (;;) {
        const oldPosts = await db
          .select({ id: schema.posts.id })
          .from(schema.posts)
          .where(and(isNotNull(schema.posts.closedAt), lt(schema.posts.closedAt, postCutoff)))
          .limit(BATCH);
        if (!oldPosts.length) break;
        const ids = oldPosts.map((p) => p.id);
        await (opts.deletePosts ?? defaultDeletePosts)(db, storage, ids);
        report.purgedPosts += ids.length;
        if (ids.length < BATCH) break;
      }
    });

    // 4) 쪽지 대화: 마지막 메시지로부터 보존 기간(기본 30일)이 지나면 종료·인수 상태와 무관하게 삭제(메시지·인수 요청은 cascade) [사용자 결정 U3]
    await step('conversations', async () => {
      const dmCutoff = new Date(now.getTime() - opts.dmRetentionDays * DAY_MS);
      for (;;) {
        const ids = (
          await db
            .select({ id: schema.conversations.id })
            .from(schema.conversations)
            .where(lt(schema.conversations.lastMessageAt, dmCutoff))
            .limit(BATCH)
        ).map((r) => r.id);
        if (!ids.length) break;
        await db.delete(schema.conversations).where(inArray(schema.conversations.id, ids));
        report.purgedConversations += ids.length;
        if (ids.length < BATCH) break;
      }
    });

    // 5) 고아 파일: photos/·ai/ 아래에서 DB 어디에도 없는 파일(유예 24시간)
    await step('orphanFiles', async () => {
      const max = opts.maxOrphanDeletes ?? DEFAULT_MAX_ORPHAN_DELETES;
      const candidates = (await storage.list({ prefixes: ORPHAN_PREFIXES })).filter((f) => now.getTime() - f.mtimeMs > ORPHAN_FILE_MS);
      if (!candidates.length) return;
      const orphans: string[] = [];
      for (let i = 0; i < candidates.length; i += KEY_CHUNK) {
        const keys = candidates.slice(i, i + KEY_CHUNK).map((f) => f.key);
        const known = new Set<string>();
        const hit = await db
          .select({ key: schema.postPhotos.storageKey, aiKey: schema.postPhotos.aiKey, blurredKey: schema.postPhotos.blurredKey })
          .from(schema.postPhotos)
          .where(or(inArray(schema.postPhotos.storageKey, keys), inArray(schema.postPhotos.aiKey, keys), inArray(schema.postPhotos.blurredKey, keys)));
        for (const r of hit) {
          known.add(r.key);
          if (r.aiKey) known.add(r.aiKey);
          if (r.blurredKey) known.add(r.blurredKey);
        }
        for (const k of keys) if (!known.has(k)) orphans.push(k);
      }
      if (!orphans.length) return;
      // 와이프 방지: DB 에 사진 행이 전혀 없는데 고아가 많다면 DB 초기화/다른 DB 연결/저장소 경로 오설정일 가능성이 크다
      const [{ n }] = (await db.execute<{ n: number }>(sql`select count(*)::int as n from post_photos`)).rows as [{ n: number }];
      if (n === 0 && orphans.length >= WIPE_GUARD_MIN_FILES) {
        report.errors.push(`orphanFiles: post_photos 가 비어 있는데 고아 후보가 ${orphans.length}건이라 정리를 건너뜀(DB/저장소 경로 확인 필요)`);
        return;
      }
      const targets = orphans.slice(0, max);
      log(`고아 파일 ${targets.length}건 삭제 예정(후보 ${orphans.length}건, 상한 ${max})`);
      for (const k of targets) await storage.delete(k);
      report.orphanFiles = targets.length;
    });

    // 6) 만료된 레이트 리밋·로그인 실패 카운터, 오래된 AI 호출 일일 카운터
    await step('counters', async () => {
      report.expiredCounters = await purgeExpiredCounters(db);
      const cutoffDay = new Date(now.getTime() - AI_COUNTER_RETENTION_DAYS * DAY_MS + 9 * 3600_000).toISOString().slice(0, 10); // KST 날짜 키
      report.aiCounters = (await db.delete(schema.aiCallCounters).where(lt(schema.aiCallCounters.day, cutoffDay)).returning({ d: schema.aiCallCounters.day })).length;
    });

    // 7) 작업 큐: 멈춘 RUNNING 복구, 7일 지난 완료 작업·30일 지난 실패 작업 삭제
    await step('jobs', async () => {
      report.recoveredJobs = await recoverStaleJobs(db);
      report.doneJobs = (
        await db
          .delete(schema.jobs)
          .where(and(eq(schema.jobs.status, 'DONE'), lt(schema.jobs.createdAt, new Date(now.getTime() - 7 * DAY_MS))))
          .returning({ id: schema.jobs.id })
      ).length;
      report.failedJobs = (
        await db
          .delete(schema.jobs)
          .where(and(eq(schema.jobs.status, 'FAILED'), lt(schema.jobs.createdAt, new Date(now.getTime() - FAILED_JOB_RETENTION_DAYS * DAY_MS))))
          .returning({ id: schema.jobs.id })
      ).length;
    });
  } finally {
    await clearCounter(db, LEASE_KEY).catch(() => undefined);
  }
  return report;
}

/** 서버 기동 시 주기 정리를 시작한다(기본 6시간 간격, 기동 직후 1회). 반환값은 중지 함수(진행 중인 실행이 끝날 때까지 기다리는 Promise). */
export function startCleanupSchedule(
  db: Db,
  storage: PhotoStorage,
  opts: CleanupOptions,
  intervalMs = 6 * 3600_000,
  log?: (msg: string) => void,
): () => Promise<void> {
  let inflight: Promise<void> = Promise.resolve();
  let stopped = false;
  const run = () => {
    if (stopped) return;
    inflight = runCleanup(db, storage, { ...opts, log })
      .then((r) => log?.(`정리 작업 ${r.skipped ? '건너뜀(다른 실행 진행 중)' : '완료'}: ${JSON.stringify(r)}`))
      .catch((e) => log?.(`정리 작업 실패: ${safeErrorMessage(e)}`));
  };
  const first = setTimeout(run, 5_000);
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return async () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(timer);
    await inflight;
  };
}
