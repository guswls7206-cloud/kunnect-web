import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import { seedDemo, DEMO_USERS, resolveDemoSeedSettings } from '../src/db/seed-demo.js';
import { LocalDiskStorage } from '../src/storage/index.js';

let exitCode = 0;
try {
  const { password, warning } = resolveDemoSeedSettings(process.env); // 운영이면 여기서 거부
  if (warning) console.warn(`경고: ${warning}`);
  const config = loadConfig();
  const { db, pool } = createDb(config.DATABASE_URL, { statementTimeoutMs: 0 });
  try {
    const { created } = await seedDemo(db, new LocalDiskStorage(config.STORAGE_DIR), { password });
    if (created) {
      console.log(`시연 데이터 생성 완료. 계정: ${DEMO_USERS.map((u) => u.loginId).join(', ')} (비밀번호: ${process.env.DEMO_PASSWORD ? 'DEMO_PASSWORD' : '개발용 기본값'})`);
    } else {
      console.log('시연 데이터가 이미 있어 건너뜀(멱등).');
    }
  } finally {
    await pool.end();
  }
} catch (e) {
  console.error('시연 시드 실패:', (e as Error).message);
  exitCode = 1;
}
process.exit(exitCode);
