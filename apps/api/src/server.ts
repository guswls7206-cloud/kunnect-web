import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { createMatchHandler } from './jobs/match-handler.js';
import { startCleanupSchedule, startEndedPostsSchedule } from './jobs/cleanup.js';
import { setMatchHandler, startWorker } from './jobs/queue.js';
import { createShutdown, installProcessHandlers } from './lifecycle.js';
import { DbCounterStore } from './lib/db-counters.js';
import { createClaudeClientFromEnv, createMatchingEngine, loadMatchingConfig } from './matching/index.js';
import { LocalDiskStorage } from './storage/index.js';

const config = loadConfig();
const { db, pool } = createDb(config.DATABASE_URL);
const storage = new LocalDiskStorage(config.STORAGE_DIR, { warn: (m) => app.log.warn(m) });
const app = await buildApp({ config, db, storage });

// 매칭 엔진: ANTHROPIC_API_KEY 가 없으면 AI 없이 로컬 점수만 사용한다(개발 환경)
const matchingConfig = loadMatchingConfig();
// AI 일일 호출 상한은 DB 카운터로 관리한다(재시작·다중 인스턴스에서도 유지)
const client = createClaudeClientFromEnv(matchingConfig, process.env, undefined, new DbCounterStore(db));
if (!client) app.log.warn('ANTHROPIC_API_KEY 미설정: 매칭은 로컬 점수만 사용하며 AUTO 알림은 발송되지 않습니다.');
const engine = createMatchingEngine({ client, config: matchingConfig });
setMatchHandler(createMatchHandler({ db, storage, engine, config: matchingConfig, noPhotoAutoNotify: config.NOPHOTO_AUTO_NOTIFY }));
const worker = startWorker(db, { logger: { warn: (m) => app.log.warn(m) } });
const stopPeriodicCleanup = startCleanupSchedule(
  db,
  storage,
  { postRetentionDays: config.RETENTION_POST_DAYS, dmRetentionDays: config.RETENTION_DM_DAYS },
  6 * 3600_000,
  (msg) => app.log.info(msg),
);
// 종료된 글(CLOSED/RETURNED)은 종료 24시간 뒤 삭제 — 24시간 정밀도를 위해 6시간 작업과 별도로 자주 실행한다
const stopEndedPosts = startEndedPostsSchedule(db, storage, {}, config.CLEANUP_ENDED_POSTS_INTERVAL_MIN * 60_000, (msg) => app.log.info(msg));
const stopCleanup = async () => {
  await Promise.all([stopPeriodicCleanup(), stopEndedPosts()]);
};

// 종료 신호·프로세스 오류 처리: HTTP 서버 → 워커(진행 중 작업 대기) → 정리 작업 → DB 풀 순으로 닫는다
const log = { info: (m: string) => app.log.info(m), error: (m: string) => app.log.error(m) };
const shutdown = createShutdown({ app, worker, stopCleanup, pool, log });
installProcessHandlers(process, shutdown, log, (code) => process.exit(code));

await app.listen({ port: config.PORT, host: '0.0.0.0' });
