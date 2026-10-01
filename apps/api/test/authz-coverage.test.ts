import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { Client, setupEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => (env = await setupEnv()));
afterAll(async () => env.close());

describe('인증 적용 범위', () => {
  it('openapi.yaml 에서 인증이 필요한 모든 엔드포인트는 비로그인 요청에 401 을 반환한다', async () => {
    const doc = parse(readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8')) as { paths: Record<string, Record<string, { security?: unknown[] }>> };
    const failures: string[] = [];
    let checked = 0;
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        if (!['get', 'post', 'patch', 'delete'].includes(method)) continue;
        if (Array.isArray(op.security) && op.security.length === 0) continue; // 공개 엔드포인트(signup/login/health)
        const url = path.replace(/\{\w+\}/g, '1');
        const res = await new Client(env.app).req(method.toUpperCase() as 'GET', url, method === 'get' ? undefined : {});
        checked += 1;
        if (res.status !== 401) failures.push(`${method.toUpperCase()} ${path} -> ${res.status}`);
      }
    }
    expect(checked).toBeGreaterThan(40);
    expect(failures).toEqual([]);
  });
});
