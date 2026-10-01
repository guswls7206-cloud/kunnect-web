import { describe, expect, it } from 'vitest';
import { retryOnConflict } from '../src/modules/handovers/service.js';

const pgError = (code: string, wrapped = false) => {
  const inner = Object.assign(new Error('pg'), { code });
  return wrapped ? Object.assign(new Error('drizzle'), { cause: inner }) : inner;
};

describe('retryOnConflict (교착/직렬화 실패 재시도)', () => {
  it('40P01 은 재시도 후 성공(드리즌이 감싼 오류의 cause.code 포함)', async () => {
    let n = 0;
    const r = await retryOnConflict(async () => {
      n++;
      if (n < 3) throw pgError('40P01', n === 2);
      return 'ok';
    });
    expect(r).toBe('ok');
    expect(n).toBe(3);
  });
  it('시도 횟수를 넘기면 마지막 오류를 그대로 던진다', async () => {
    let n = 0;
    await expect(
      retryOnConflict(async () => {
        n++;
        throw pgError('40001');
      }, 2),
    ).rejects.toMatchObject({ code: '40001' });
    expect(n).toBe(2);
  });
  it('다른 오류(비즈니스 오류 포함)는 재시도하지 않는다', async () => {
    let n = 0;
    await expect(
      retryOnConflict(async () => {
        n++;
        throw new Error('409 conflict');
      }),
    ).rejects.toThrow('409 conflict');
    expect(n).toBe(1);
  });
});
