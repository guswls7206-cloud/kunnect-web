/** 일일 호출 상한(KST 자정 리셋)과 동시 실행 제한. 프로세스 메모리 기반(데모 단일 서버 가정). */

const KST_OFFSET_MS = 9 * 3_600_000;

/**
 * 일일 AI 호출 카운터 저장소. 기본 구현은 프로세스 메모리(InMemoryCounterStore)이며,
 * 재시작·다중 인스턴스에서도 상한을 지키려면 DB 등으로 구현해 주입한다.
 *
 * 계약(구현 필수):
 * - day는 KST 기준 'YYYY-MM-DD' 문자열이다(날짜 경계는 호출 측 DailyCallLimiter가 계산).
 * - tryConsume은 **원자적 check-and-increment**여야 한다: 현재 카운트 + n ≤ limit 이면 카운트를 n 증가시키고
 *   { ok: true, count: 증가 후 값 }, 아니면 증가 없이 { ok: false, count: 현재 값 }을 반환한다.
 *   (SQL 예: UPDATE counters SET n = n + :n WHERE day = :day AND n + :n <= :limit; 영향 행 0이면 ok=false,
 *   행이 없으면 INSERT ... ON CONFLICT 로 생성). 동시 호출이 상한을 넘기면 안 된다.
 * - count는 읽기 전용 조회(없으면 0).
 * - 저장소 오류는 throw한다. 클라이언트는 이를 AiError('UNAVAILABLE')로 바꿔 AI 단계를 건너뛴다(fail-closed, 비용 보호).
 * - 호출이 실제로 실패해도 소비한 카운트는 돌려주지 않는다(재시도도 비용이므로).
 */
export interface CounterStore {
  tryConsume(day: string, n: number, limit: number): Promise<{ ok: boolean; count: number }>;
  count(day: string): Promise<number>;
}

/** 프로세스 메모리 구현. 오래된 날짜 키는 새 날짜가 기록될 때 정리한다. 단일 이벤트 루프라 원자성은 자연히 보장된다. */
export class InMemoryCounterStore implements CounterStore {
  private readonly days = new Map<string, number>();

  async tryConsume(day: string, n: number, limit: number): Promise<{ ok: boolean; count: number }> {
    const cur = this.days.get(day) ?? 0;
    if (cur + n > limit) return { ok: false, count: cur };
    for (const k of this.days.keys()) if (k !== day) this.days.delete(k);
    this.days.set(day, cur + n);
    return { ok: true, count: cur + n };
  }

  async count(day: string): Promise<number> {
    return this.days.get(day) ?? 0;
  }
}

export class DailyCallLimiter {
  constructor(
    private readonly limit: number,
    private readonly now: () => number = Date.now,
    private readonly store: CounterStore = new InMemoryCounterStore(),
  ) {}

  private day(): string {
    return new Date(this.now() + KST_OFFSET_MS).toISOString().slice(0, 10);
  }

  /** 호출 1건을 예약한다. 상한 초과면 false(카운트 증가 없음). 저장소 오류는 throw */
  async tryAcquire(): Promise<boolean> {
    return (await this.store.tryConsume(this.day(), 1, this.limit)).ok;
  }

  async used(): Promise<number> {
    return this.store.count(this.day());
  }
}

export class Semaphore {
  private active = 0;
  private waiters: (() => void)[] = [];
  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active < this.max) this.active++;
    else await new Promise<void>((r) => this.waiters.push(r)); // 슬롯을 대기자에게 직접 넘겨받음
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }
}
