import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/client.js';
import { createShutdown, installProcessHandlers } from '../src/lifecycle.js';

const logger = () => {
  const lines: string[] = [];
  return { lines, info: (m: string) => lines.push(`I:${m}`), error: (m: string) => lines.push(`E:${m}`) };
};

describe('H-D: 정상 종료 순서', () => {
  it('HTTP 서버 → 워커 → 정리 작업 → DB 풀 순서로 닫고 완료를 기록한다', async () => {
    const order: string[] = [];
    const log = logger();
    const shutdown = createShutdown({
      app: { close: async () => void order.push('app') },
      worker: { stop: async () => void order.push('worker') },
      stopCleanup: async () => void order.push('cleanup'),
      pool: { end: async () => void order.push('pool') },
      log,
    });
    await shutdown('SIGTERM');
    expect(order).toEqual(['app', 'worker', 'cleanup', 'pool']);
    expect(log.lines[0]).toContain('종료 시작: SIGTERM');
    expect(log.lines.at(-1)).toBe('I:종료 완료');
  });

  it('워커가 진행 중 작업을 마칠 때까지 기다린 뒤에야 풀을 닫는다', async () => {
    const order: string[] = [];
    const shutdown = createShutdown({
      app: { close: async () => undefined },
      worker: { stop: () => new Promise<void>((r) => setTimeout(() => (order.push('job-done'), r()), 100)) },
      stopCleanup: async () => undefined,
      pool: { end: async () => void order.push('pool') },
      log: logger(),
    });
    await shutdown('SIGINT');
    expect(order).toEqual(['job-done', 'pool']);
  });

  it('한 단계가 실패해도 나머지 단계(특히 풀 종료)를 계속한다', async () => {
    const order: string[] = [];
    const log = logger();
    const shutdown = createShutdown({
      app: { close: async () => { throw new Error('close boom'); } },
      worker: { stop: async () => void order.push('worker') },
      stopCleanup: async () => { throw new Error('cleanup boom'); },
      pool: { end: async () => void order.push('pool') },
      log,
    });
    await shutdown('SIGTERM');
    expect(order).toEqual(['worker', 'pool']);
    expect(log.lines.filter((l) => l.startsWith('E:종료 단계 실패'))).toHaveLength(2);
  });

  it('여러 번 호출해도 한 번만 실행된다(멱등)', async () => {
    const end = vi.fn(async () => undefined);
    const shutdown = createShutdown({ app: { close: async () => undefined }, worker: { stop: async () => undefined }, stopCleanup: async () => undefined, pool: { end }, log: logger() });
    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT'), shutdown('x')]);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('제한 시간을 넘기면 남은 단계를 포기하고 반환한다(종료가 영원히 막히지 않음)', async () => {
    const log = logger();
    const shutdown = createShutdown({
      app: { close: () => new Promise<void>(() => undefined) }, // 영원히 안 닫힘
      worker: { stop: async () => undefined },
      stopCleanup: async () => undefined,
      pool: { end: async () => undefined },
      log,
      timeoutMs: 80,
    });
    const t = Date.now();
    await shutdown('SIGTERM');
    expect(Date.now() - t).toBeLessThan(2000);
    expect(log.lines.some((l) => l.includes('종료 제한 시간'))).toBe(true);
  });
});

describe('H-D: 프로세스 이벤트 처리', () => {
  function setup() {
    const proc = new EventEmitter();
    const log = logger();
    const shutdown = vi.fn(async () => undefined);
    const exit = vi.fn();
    installProcessHandlers(proc, shutdown, log, exit);
    return { proc, log, shutdown, exit };
  }
  it('SIGTERM/SIGINT 는 정상 종료 후 exit(0)', async () => {
    const { proc, shutdown, exit } = setup();
    proc.emit('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(shutdown).toHaveBeenCalledWith('SIGTERM');
    proc.emit('SIGINT');
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledWith('SIGINT'));
  });
  it('unhandledRejection 은 기록하고 종료를 시도한 뒤 exit(1)', async () => {
    const { proc, log, shutdown, exit } = setup();
    proc.emit('unhandledRejection', new Error('rejected!'));
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(shutdown).toHaveBeenCalledWith('unhandledRejection');
    expect(log.lines.some((l) => l.startsWith('E:unhandledRejection') && l.includes('rejected!'))).toBe(true);
  });
  it('uncaughtException 도 동일(문자열 오류 포함)', async () => {
    const { proc, log, exit } = setup();
    proc.emit('uncaughtException', 'plain string error');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(log.lines.some((l) => l.includes('plain string error'))).toBe(true);
  });
});

describe('H-E: DB 풀 설정', () => {
  it("유휴 연결 'error' 이벤트가 uncaught exception 이 되지 않고 접속 문자열 없이 기록된다", async () => {
    const msgs: string[] = [];
    const { pool } = createDb('postgres://user:secret-pw@localhost:1/db', { onPoolError: (m) => msgs.push(m) });
    expect(pool.listenerCount('error')).toBeGreaterThan(0);
    expect(() => pool.emit('error', new Error('terminating connection due to administrator command'))).not.toThrow();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain('terminating connection');
    expect(msgs[0]).not.toContain('secret-pw');
    await pool.end();
  });
  it('연결 제한 시간·유휴·문장 실행 제한이 설정된다(마이그레이션용으로 문장 제한은 끌 수 있다)', async () => {
    const a = createDb('postgres://u:p@localhost:1/db');
    const o = (a.pool as unknown as { options: Record<string, unknown> }).options;
    expect(o.connectionTimeoutMillis).toBe(5000);
    expect(o.idleTimeoutMillis).toBe(30000);
    expect(o.statement_timeout).toBe(30000);
    const b = createDb('postgres://u:p@localhost:1/db', { statementTimeoutMs: 0 });
    expect((b.pool as unknown as { options: Record<string, unknown> }).options.statement_timeout).toBeUndefined();
    await Promise.all([a.pool.end(), b.pool.end()]);
  });
});
