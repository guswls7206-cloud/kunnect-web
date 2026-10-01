import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import { seedCatalog } from '../src/db/seed.js';

const { db, pool } = createDb(loadConfig().DATABASE_URL, { statementTimeoutMs: 0 });
try {
  await seedCatalog(db);
  console.log('시드 완료 (위치: 지정 12곳)');
} finally {
  await pool.end();
}
