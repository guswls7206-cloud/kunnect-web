import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { setupEnv, type TestEnv } from './helpers.js';

const run = promisify(execFile);
let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
  await env.reset(); // 앞선 테스트 파일이 남긴 데이터(demo_ 계정 등)에 의존하지 않도록 초기화
});
afterAll(async () => env.close());

const tsx = (script: string, extraEnv: Record<string, string> = {}) =>
  run(process.execPath, ['--import', 'tsx', script], {
    cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    env: { ...process.env, NODE_ENV: 'test', ...extraEnv },
    timeout: 120_000,
  });

describe('M19/M20: 운영 스크립트', () => {
  it('db:migrate 는 이미 적용된 DB 에서도 성공하고(멱등) 종료한다', async () => {
    const r = await tsx('scripts/migrate.ts');
    expect(r.stdout).toContain('마이그레이션 완료');
  }, 130_000);

  it('마이그레이션 advisory lock 이 잡혀 있으면 풀려날 때까지 기다린다', async () => {
    // 같은 키를 다른 연결이 쥐고 있는 동안 스크립트는 끝나지 않아야 한다
    const holder = await (env.db as unknown as { $client: import('pg').Pool }).$client.connect();
    try {
      await holder.query('select pg_advisory_lock($1)', [7_340_002]);
      let done = false;
      const p = tsx('scripts/migrate.ts').then((r) => ((done = true), r));
      await new Promise((r) => setTimeout(r, 4000));
      expect(done).toBe(false);
      await holder.query('select pg_advisory_unlock($1)', [7_340_002]);
      const r = await p;
      expect(r.stdout).toContain('마이그레이션 완료');
    } finally {
      holder.release();
    }
  }, 140_000);

  it('db:seed:demo 는 NODE_ENV=production 에서 거부하고 종료 코드 1', async () => {
    const err = await tsx('scripts/seed-demo.ts', { NODE_ENV: 'production', DATABASE_URL: process.env.DATABASE_URL!, ALLOWED_ORIGINS: 'https://x.example' }).then(
      () => null,
      (e: { code?: number; stderr?: string }) => e,
    );
    expect(err?.code).toBe(1);
    expect(err?.stderr).toContain('운영 환경');
    expect(await env.db.execute(sql`select 1 from users where login_id like 'demo\_%'`).then((r) => r.rows)).toHaveLength(0);
  }, 130_000);
});
