// 테스트용 PostgreSQL 을 임시 디렉터리에 띄운다(Docker 불필요). TEST_DATABASE_URL 이 있으면 그것을 사용한다.
import EmbeddedPostgres from 'embedded-postgres';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default async function setup() {
  if (process.env.TEST_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'kunnect-pg-'));
  const port = 54000 + Math.floor(Math.random() * 900);
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'kunnect', password: 'kunnect', port, persistent: false });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('kunnect_test');
  process.env.DATABASE_URL = `postgres://kunnect:kunnect@localhost:${port}/kunnect_test`;
  return async () => {
    await pg.stop();
    rmSync(dir, { recursive: true, force: true });
  };
}
