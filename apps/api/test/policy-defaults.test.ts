import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('정책 기본값 (사용자 결정 반영)', () => {
  it('NOPHOTO_AUTO_NOTIFY 기본은 true 이고 false 로 되돌릴 수 있다', () => {
    expect(loadConfig({ NODE_ENV: 'test' }).NOPHOTO_AUTO_NOTIFY).toBe(true);
    expect(loadConfig({ NODE_ENV: 'test', NOPHOTO_AUTO_NOTIFY: 'false' }).NOPHOTO_AUTO_NOTIFY).toBe(false);
  });
});
