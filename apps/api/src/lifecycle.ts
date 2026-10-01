/**
 * 프로세스 수명 주기: 정상 종료 순서와 프로세스 수준 오류 처리. 서버 부트스트랩(server.ts)과 분리해 테스트할 수 있게 한다.
 *
 * 종료 순서: HTTP 서버(app.close: 새 연결 거부 + 진행 중 요청 완료) → 매칭 워커(진행 중 작업 완료까지 대기)
 *          → 정리 작업(진행 중 실행 완료까지 대기) → DB 풀 종료.
 * 풀을 마지막에 닫아야 진행 중 요청/작업의 DB 쓰기가 실패하지 않고 작업이 RUNNING 에 멈추지 않는다.
 */
export interface ShutdownLogger {
  info(msg: string): void;
  error(msg: string): void;
}

export interface ShutdownDeps {
  app: { close(): Promise<unknown> };
  worker: { stop(): Promise<void> };
  stopCleanup: () => Promise<void>;
  pool: { end(): Promise<void> };
  log: ShutdownLogger;
  /** 전체 종료 제한 시간(기본 20초). 넘으면 남은 단계를 포기하고 반환한다. */
  timeoutMs?: number;
}

export function createShutdown(deps: ShutdownDeps): (reason: string) => Promise<void> {
  let running: Promise<void> | null = null;
  return (reason: string) => {
    running ??= (async () => {
      deps.log.info(`종료 시작: ${reason}`);
      const steps: [string, () => Promise<unknown>][] = [
        ['HTTP 서버', () => deps.app.close()],
        ['매칭 워커', () => deps.worker.stop()],
        ['정리 작업', () => deps.stopCleanup()],
        ['DB 풀', () => deps.pool.end()],
      ];
      const all = (async () => {
        for (const [name, fn] of steps) {
          try {
            await fn();
          } catch (e) {
            deps.log.error(`종료 단계 실패(${name}): ${(e as Error)?.message ?? String(e)}`); // 한 단계가 실패해도 다음 단계를 계속한다
          }
        }
      })();
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          deps.log.error(`종료 제한 시간(${deps.timeoutMs ?? 20_000}ms) 초과: 남은 단계를 포기합니다.`);
          resolve();
        }, deps.timeoutMs ?? 20_000);
      });
      await Promise.race([all, timeout]);
      clearTimeout(timer);
      deps.log.info('종료 완료');
    })();
    return running;
  };
}

/** process 의 일부만 쓰므로 테스트에서 EventEmitter 로 대체할 수 있다 */
export interface ProcessLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

/**
 * SIGTERM/SIGINT → 정상 종료 후 exit(0). unhandledRejection/uncaughtException → 오류 기록 후 종료 시도, exit(1).
 * (오류 상태의 프로세스를 계속 돌리면 작업이 조용히 멈추므로 종료해 감독자(systemd/Docker 등)가 재기동하게 한다.)
 */
export function installProcessHandlers(proc: ProcessLike, shutdown: (reason: string) => Promise<void>, log: ShutdownLogger, exit: (code: number) => void) {
  const graceful = (signal: string) => () => void shutdown(signal).then(() => exit(0));
  proc.on('SIGTERM', graceful('SIGTERM'));
  proc.on('SIGINT', graceful('SIGINT'));
  const fatal = (kind: string) => (err: unknown) => {
    log.error(`${kind}: ${(err as Error)?.stack ?? String(err)}`);
    void shutdown(kind).finally(() => exit(1));
  };
  proc.on('unhandledRejection', fatal('unhandledRejection'));
  proc.on('uncaughtException', fatal('uncaughtException'));
}
