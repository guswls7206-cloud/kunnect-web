import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { loadConfig } from '../src/config.js';

const prod = { NODE_ENV: 'production', DATABASE_URL: 'postgres://app:pw@db.internal:5432/kunnect', ALLOWED_ORIGINS: 'https://kunnect.example' };
const messages = (env: Record<string, string>) => {
  try {
    loadConfig(env as NodeJS.ProcessEnv);
    return [];
  } catch (e) {
    return (e as ZodError).issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  }
};

describe('M20: 설정 검증', () => {
  it('개발/테스트에서는 개발용 기본값이 채워진다', () => {
    const c = loadConfig({ NODE_ENV: 'development' } as NodeJS.ProcessEnv);
    expect(c.DATABASE_URL).toContain('localhost');
    expect(c.ALLOWED_ORIGINS).toBe('http://localhost:3000');
    expect(c.PORT).toBe(4000);
    expect(c.RETENTION_POST_DAYS).toBe(90);
  });
  it('운영: 정상 설정은 통과하고 값이 그대로 반영된다', () => {
    const c = loadConfig(prod as NodeJS.ProcessEnv);
    expect(c.DATABASE_URL).toBe(prod.DATABASE_URL);
    expect(c.ALLOWED_ORIGINS).toBe(prod.ALLOWED_ORIGINS);
  });
  it('운영: DATABASE_URL/ALLOWED_ORIGINS 누락은 거부(개발용 기본값으로 조용히 기동하지 않음)', () => {
    expect(messages({ NODE_ENV: 'production', ALLOWED_ORIGINS: prod.ALLOWED_ORIGINS }).join('|')).toContain('DATABASE_URL');
    expect(messages({ NODE_ENV: 'production', DATABASE_URL: prod.DATABASE_URL }).join('|')).toContain('ALLOWED_ORIGINS');
  });
  it('운영: 개발용 값을 명시해도 거부', () => {
    const m = messages({ ...prod, DATABASE_URL: 'postgres://kunnect:kunnect@localhost:5432/kunnect', ALLOWED_ORIGINS: 'http://localhost:3000' });
    expect(m.some((x) => x.startsWith('DATABASE_URL'))).toBe(true);
    expect(m.some((x) => x.startsWith('ALLOWED_ORIGINS'))).toBe(true);
  });
  it('운영: 보존 일수 0(오타·빈 값 변환 포함)은 거부, 개발에서는 허용', () => {
    expect(messages({ ...prod, RETENTION_POST_DAYS: '0' }).join('|')).toContain('RETENTION_POST_DAYS');
    expect(messages({ ...prod, RETENTION_DM_DAYS: '0' }).join('|')).toContain('RETENTION_DM_DAYS');
    expect(messages({ ...prod, RETENTION_POST_DAYS: '' }).join('|')).toContain('RETENTION_POST_DAYS'); // 빈 문자열은 0 으로 변환된다
    expect(loadConfig({ NODE_ENV: 'development', RETENTION_POST_DAYS: '0' } as NodeJS.ProcessEnv).RETENTION_POST_DAYS).toBe(0);
  });
  it('PORT 범위 검증(모든 환경)', () => {
    for (const p of ['0', '70000', '-1', 'abc', '3.5']) expect(messages({ NODE_ENV: 'development', PORT: p }).join('|')).toContain('PORT');
    expect(loadConfig({ NODE_ENV: 'development', PORT: '8080' } as NodeJS.ProcessEnv).PORT).toBe(8080);
  });
  it('여러 문제를 한 번에 보고한다', () => {
    expect(messages({ NODE_ENV: 'production' }).length).toBeGreaterThanOrEqual(2);
  });
});
