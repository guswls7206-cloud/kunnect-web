import { describe, expect, it, vi } from 'vitest';
import { ClaudeClient, type MessagesLike } from '../claude.js';
import { DailyCallLimiter, InMemoryCounterStore, type CounterStore } from '../limiter.js';
import { loadMatchingConfig } from '../weights.js';
import { FAKE_IMG } from './fixtures.js';

const ok = {
  content: [{ type: 'text', text: JSON.stringify({ category: 'other', colors: [], brand: 'unknown', shape: 'unknown', features: [], has_sensitive_info: false, confidence: 0.5 }) }],
  stop_reason: 'end_turn',
};

describe('InMemoryCounterStore (CounterStore 계약)', () => {
  it('limit까지만 소비, 초과 시 증가 없이 ok=false', async () => {
    const s = new InMemoryCounterStore();
    expect(await s.tryConsume('2026-10-01', 1, 2)).toEqual({ ok: true, count: 1 });
    expect(await s.tryConsume('2026-10-01', 1, 2)).toEqual({ ok: true, count: 2 });
    expect(await s.tryConsume('2026-10-01', 1, 2)).toEqual({ ok: false, count: 2 });
    expect(await s.count('2026-10-01')).toBe(2);
  });
  it('n>1 소비는 전부 가능할 때만(부분 소비 없음)', async () => {
    const s = new InMemoryCounterStore();
    await s.tryConsume('d', 3, 4);
    expect(await s.tryConsume('d', 2, 4)).toEqual({ ok: false, count: 3 });
  });
  it('동시 호출이 limit을 넘기지 않는다(원자성)', async () => {
    const s = new InMemoryCounterStore();
    const rs = await Promise.all(Array.from({ length: 50 }, () => s.tryConsume('d', 1, 10)));
    expect(rs.filter((r) => r.ok)).toHaveLength(10);
    expect(await s.count('d')).toBe(10);
  });
  it('다른 날짜는 독립, 새 날짜 기록 시 이전 날짜 키 정리', async () => {
    const s = new InMemoryCounterStore();
    await s.tryConsume('d1', 1, 1);
    expect(await s.tryConsume('d2', 1, 1)).toMatchObject({ ok: true });
    expect(await s.count('d1')).toBe(0);
  });
});

describe('주입된 CounterStore', () => {
  it('ClaudeClient는 주입된 저장소의 결과를 따른다(상한은 저장소가 판단)', async () => {
    const calls: [string, number, number][] = [];
    const store: CounterStore = {
      tryConsume: async (day, n, limit) => (calls.push([day, n, limit]), { ok: false, count: limit }),
      count: async () => 0,
    };
    const create = vi.fn(async () => ok);
    const c = new ClaudeClient({ config: loadMatchingConfig({ AI_DAILY_CALL_LIMIT: '7' }), messages: { create } as MessagesLike, counterStore: store });
    await expect(c.extractAttributes([FAKE_IMG])).rejects.toMatchObject({ kind: 'CAP_EXCEEDED' });
    expect(create).not.toHaveBeenCalled();
    expect(calls[0]?.[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(calls[0]?.slice(1)).toEqual([1, 7]);
  });
  it('저장소 오류는 fail-closed: HTTP 호출 없이 UNAVAILABLE', async () => {
    const store: CounterStore = { tryConsume: async () => { throw new Error('db down'); }, count: async () => 0 };
    const create = vi.fn(async () => ok);
    const c = new ClaudeClient({ config: loadMatchingConfig({}), messages: { create } as MessagesLike, counterStore: store });
    await expect(c.extractAttributes([FAKE_IMG])).rejects.toMatchObject({ kind: 'UNAVAILABLE' });
    expect(create).not.toHaveBeenCalled();
  });
  it('callsToday()는 저장소 카운트를 반환', async () => {
    const store = new InMemoryCounterStore();
    const c = new ClaudeClient({ config: loadMatchingConfig({}), messages: { create: async () => ok } as MessagesLike, counterStore: store });
    await c.extractAttributes([FAKE_IMG]);
    expect(await c.callsToday()).toBe(1);
  });
  it('DailyCallLimiter: 두 클라이언트가 같은 저장소를 공유하면 상한을 공유한다(다중 인스턴스 모사)', async () => {
    const store = new InMemoryCounterStore();
    const a = new DailyCallLimiter(3, Date.now, store);
    const b = new DailyCallLimiter(3, Date.now, store);
    const rs = [await a.tryAcquire(), await b.tryAcquire(), await a.tryAcquire(), await b.tryAcquire()];
    expect(rs).toEqual([true, true, true, false]);
  });
});
