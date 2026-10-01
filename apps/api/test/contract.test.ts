import { describe, expect, it } from 'vitest';
import { contractViolations } from './helpers.js';

describe('계약 검증기 자체 점검', () => {
  it('잘못된 응답 본문은 위반으로 검출한다', () => {
    expect(contractViolations('GET', '/me', 200, { id: 'x' }).length).toBeGreaterThan(0);
    expect(contractViolations('GET', '/posts', 200, { items: [{ id: 1 }], nextCursor: null }).length).toBeGreaterThan(0);
    expect(contractViolations('GET', '/health', 200, { status: 'ok' })).toEqual([]);
    expect(contractViolations('GET', '/posts/5', 404, { nope: 1 }).length).toBeGreaterThan(0);
    expect(contractViolations('GET', '/posts/5', 404, { error: { code: 'NOT_FOUND', message: 'x' } })).toEqual([]);
  });
});
