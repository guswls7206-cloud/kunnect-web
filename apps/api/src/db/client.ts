import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';

export type Db = ReturnType<typeof createDb>['db'];

export interface CreateDbOptions {
  max?: number;
  /** 연결 획득 제한(ms). DB 가 응답하지 않을 때 요청이 무한 대기하지 않게 한다. 기본 5초 */
  connectionTimeoutMs?: number;
  /** 유휴 연결 정리(ms). 기본 30초 */
  idleTimeoutMs?: number;
  /** 서버 측 문장 실행 제한(ms). 0 이면 비활성(마이그레이션 등). 기본 30초 */
  statementTimeoutMs?: number;
  /** 풀 오류 로거(기본 console.error). 접속 문자열/쿼리 파라미터는 기록하지 않는다 */
  onPoolError?: (message: string) => void;
}

export function createDb(databaseUrl: string, opts: CreateDbOptions = {}) {
  const statementTimeout = opts.statementTimeoutMs ?? 30_000;
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: opts.max ?? 10,
    connectionTimeoutMillis: opts.connectionTimeoutMs ?? 5_000,
    idleTimeoutMillis: opts.idleTimeoutMs ?? 30_000,
    ...(statementTimeout > 0 ? { statement_timeout: statementTimeout, query_timeout: statementTimeout + 5_000 } : {}),
  });
  // 유휴 연결에서 발생한 오류(DB 재시작·네트워크 끊김)에 리스너가 없으면 Node 가 uncaught exception 으로 프로세스를 죽인다.
  // 풀은 해당 연결을 폐기하고 다음 요청에서 새로 연결하므로 기록만 한다.
  pool.on('error', (e) => (opts.onPoolError ?? ((m) => console.error(m)))(`DB 풀 오류(유휴 연결): ${(e as Error)?.message ?? 'unknown'}`));
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export async function runMigrations(db: Db) {
  const folder = fileURLToPath(new URL('./migrations', import.meta.url));
  await migrate(db, { migrationsFolder: folder });
}

export { schema };
