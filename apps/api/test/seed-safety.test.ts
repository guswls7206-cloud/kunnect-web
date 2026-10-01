import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { resolveDemoSeedSettings, seedDemo } from '../src/db/seed-demo.js';
import { LocalDiskStorage, type PhotoStorage } from '../src/storage/index.js';
import { setupEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => (env = await setupEnv()));
afterAll(async () => env.close());
beforeEach(async () => env.reset());

const rows = async <T>(q: ReturnType<typeof sql>) => (await env.db.execute<T & Record<string, unknown>>(q)).rows;

describe('M19: 시연 시드 안전장치', () => {
  it('운영(NODE_ENV=production)에서는 거부한다', () => {
    expect(() => resolveDemoSeedSettings({ NODE_ENV: 'production', DEMO_PASSWORD: 'x' })).toThrow('운영 환경');
  });
  it('DEMO_PASSWORD 가 있으면 그 값을 쓰고 경고 없음, 없으면 기본값 + 경고', () => {
    expect(resolveDemoSeedSettings({ NODE_ENV: 'development', DEMO_PASSWORD: ' My-Demo-Pw-1 ' })).toEqual({ password: 'My-Demo-Pw-1' });
    const d = resolveDemoSeedSettings({ NODE_ENV: 'development' });
    expect(d.password).toBeTruthy();
    expect(d.warning).toContain('DEMO_PASSWORD');
    expect(resolveDemoSeedSettings({ DEMO_PASSWORD: '   ' }).warning).toBeTruthy(); // 공백뿐이면 미설정 취급
  });

  it('중간에 실패하면 전부 롤백되고(사용자·글 없음) 저장한 사진 파일도 지워지며, 다시 실행하면 정상 생성된다', async () => {
    const real = new LocalDiskStorage(env.storageDir);
    let calls = 0;
    const flaky: PhotoStorage = {
      save: async (k, d) => {
        calls += 1;
        if (calls === 3) throw new Error('디스크 오류(모의)');
        return real.save(k, d);
      },
      delete: (k) => real.delete(k),
      read: (k) => real.read(k),
      list: (o) => real.list(o),
    };
    await expect(seedDemo(env.db, flaky, { password: 'Demo-Test-Pw1' })).rejects.toThrow('디스크 오류');
    expect(await rows(sql`select 1 from users where login_id like 'demo\_%'`)).toHaveLength(0);
    expect(await rows(sql`select 1 from posts`)).toHaveLength(0);
    expect(existsSync(join(env.storageDir, 'photos/demo-1.jpg'))).toBe(false);
    expect(existsSync(join(env.storageDir, 'photos/demo-2.jpg'))).toBe(false);
    // 반쯤 만들어진 상태가 남지 않으므로 재실행이 "이미 있음"으로 건너뛰지 않는다
    expect((await seedDemo(env.db, real, { password: 'Demo-Test-Pw1' })).created).toBe(true);
    expect(await rows(sql`select 1 from users where login_id like 'demo\_%'`)).toHaveLength(4);
  });

  it('동시에 두 번 실행해도 한 번만 생성된다(advisory lock)', async () => {
    const storage = new LocalDiskStorage(env.storageDir);
    const rs = await Promise.all([
      seedDemo(env.db, storage, { password: 'Demo-Test-Pw1' }),
      seedDemo(env.db, storage, { password: 'Demo-Test-Pw1' }),
    ]);
    expect(rs.filter((r) => r.created)).toHaveLength(1);
    expect(await rows(sql`select 1 from users where login_id like 'demo\_%'`)).toHaveLength(4);
  });
});
