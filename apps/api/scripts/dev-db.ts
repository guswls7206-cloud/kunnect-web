// Docker 없이 쓰는 로컬 개발 DB: 공식 PostgreSQL 바이너리(embedded-postgres)를 실행한다.
// docker-compose 의 postgres 와 동일한 접속 정보(kunnect/kunnect@localhost:5432/kunnect)를 사용한다.
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';

const dir = process.env.PGDATA_DIR ?? './.pgdata';
const port = Number(process.env.PGPORT ?? 5432);
const fresh = !existsSync(`${dir}/PG_VERSION`);

const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'kunnect', password: 'kunnect', port, persistent: true });
if (fresh) await pg.initialise();
await pg.start();
if (fresh) await pg.createDatabase('kunnect');
console.log(`PostgreSQL 실행 중: postgres://kunnect:kunnect@localhost:${port}/kunnect (종료: Ctrl+C)`);

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
