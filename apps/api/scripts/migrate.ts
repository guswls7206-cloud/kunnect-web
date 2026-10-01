import { loadConfig } from '../src/config.js';
import { createDb, runMigrations } from '../src/db/client.js';

/** 두 배포가 동시에 마이그레이션을 돌리지 않도록 세션 advisory lock 을 잡는다(전용 연결 1개). 마이그레이션은 오래 걸릴 수 있어 문장 제한 시간을 끈다. */
const MIGRATE_LOCK_KEY = 7_340_002;

const { db, pool } = createDb(loadConfig().DATABASE_URL, { statementTimeoutMs: 0, max: 2 });
const lockClient = await pool.connect();
try {
  await lockClient.query('select pg_advisory_lock($1)', [MIGRATE_LOCK_KEY]);
  await runMigrations(db);
  console.log('마이그레이션 완료');
} finally {
  await lockClient.query('select pg_advisory_unlock($1)', [MIGRATE_LOCK_KEY]).catch(() => undefined);
  lockClient.release();
  await pool.end();
}
