import { lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { schema } from '../db/client.js';
import type { CounterStore } from '../matching/index.js';

/**
 * 고정 윈도 카운터(PostgreSQL). 한 번의 원자적 upsert 로 증가시키고 현재 값·남은 시간을 돌려준다.
 * 윈도가 만료된 행은 1 로 초기화한다. 프로세스 재시작·다중 인스턴스에서도 일관되게 동작한다.
 */
export async function bumpCounter(db: Db, key: string, windowMs: number): Promise<{ count: number; ttlMs: number }> {
  const res = await db.execute<{ count: number; ttl_ms: number }>(sql`
    insert into rate_counters (key, count, expires_at)
    values (${key}, 1, now() + (${windowMs}::double precision * interval '1 millisecond'))
    on conflict (key) do update set
      count = case when rate_counters.expires_at <= now() then 1 else rate_counters.count + 1 end,
      expires_at = case when rate_counters.expires_at <= now() then now() + (${windowMs}::double precision * interval '1 millisecond') else rate_counters.expires_at end
    returning count, (extract(epoch from (expires_at - now())) * 1000)::double precision as ttl_ms`);
  const row = res.rows[0]!;
  return { count: row.count, ttlMs: Math.max(Math.round(Number(row.ttl_ms)), 0) };
}

/** 증가 없이 현재 값을 읽는다(만료되었으면 0). */
export async function readCounter(db: Db, key: string): Promise<number> {
  const res = await db.execute<{ count: number }>(sql`select count from rate_counters where key = ${key} and expires_at > now()`);
  return res.rows[0]?.count ?? 0;
}

export async function clearCounter(db: Db, key: string): Promise<void> {
  await db.execute(sql`delete from rate_counters where key = ${key}`);
}

/** 만료된 카운터 행 삭제(정리 작업). 삭제 건수를 돌려준다. */
export async function purgeExpiredCounters(db: Db): Promise<number> {
  return (await db.delete(schema.rateCounters).where(lt(schema.rateCounters.expiresAt, new Date())).returning({ k: schema.rateCounters.key })).length;
}

/**
 * @fastify/rate-limit 용 PostgreSQL 저장소 팩토리.
 * 라우트별 child 저장소가 만들어지며, 키에 메서드·경로를 붙여 라우트 사이에 카운터가 섞이지 않게 한다.
 */
export function createDbRateStore(db: Db) {
  return class DbRateStore {
    private readonly ns: string;
    constructor(opts: { routeInfo?: { method?: string | string[]; url?: string } } = {}) {
      const m = Array.isArray(opts.routeInfo?.method) ? opts.routeInfo.method.join(',') : (opts.routeInfo?.method ?? '*');
      this.ns = `rl:${m}:${opts.routeInfo?.url ?? '*'}:`;
    }
    incr(key: string, cb: (err: Error | null, res?: { current: number; ttl: number }) => void, timeWindow: number) {
      bumpCounter(db, this.ns + key, timeWindow).then(
        (r) => cb(null, { current: r.count, ttl: r.ttlMs }),
        (e) => cb(e as Error),
      );
    }
    child(routeOptions: { routeInfo?: { method?: string | string[]; url?: string } }) {
      return new DbRateStore(routeOptions);
    }
  };
}

/**
 * AI 일일 호출 상한 카운터의 PostgreSQL 구현(matching 의 CounterStore 계약).
 * tryConsume 은 원자적 check-and-increment 이다: 상한을 넘으면 변경 없이 ok=false.
 */
export class DbCounterStore implements CounterStore {
  constructor(private readonly db: Db) {}

  async tryConsume(day: string, n: number, limit: number): Promise<{ ok: boolean; count: number }> {
    if (n > limit) return { ok: false, count: await this.count(day) };
    const res = await this.db.execute<{ n: number }>(sql`
      insert into ai_call_counters (day, n) values (${day}, ${n})
      on conflict (day) do update set n = ai_call_counters.n + ${n}
        where ai_call_counters.n + ${n} <= ${limit}
      returning n`);
    if (res.rows[0]) return { ok: true, count: res.rows[0].n };
    return { ok: false, count: await this.count(day) };
  }

  async count(day: string): Promise<number> {
    const res = await this.db.execute<{ n: number }>(sql`select n from ai_call_counters where day = ${day}`);
    return res.rows[0]?.n ?? 0;
  }
}

/**
 * 로그·작업 오류 기록용 안전한 메시지. Drizzle 오류는 message/params 에 쿼리 파라미터(비밀번호 해시, 쪽지 본문 등)가
 * 들어 있으므로 원인(pg 오류)의 메시지만 남긴다.
 */
export function isDrizzleQueryError(err: { name?: string; message?: string; query?: unknown; params?: unknown }): boolean {
  return err?.name === 'DrizzleQueryError' || err?.query !== undefined || err?.params !== undefined || String(err?.message ?? '').startsWith('Failed query');
}

export function safeErrorMessage(e: unknown): string {
  const err = e as { name?: string; message?: string; query?: string; params?: unknown; cause?: { message?: string; code?: string } };
  // Drizzle 쿼리 오류는 name 이 'Error' 로 보일 수 있어 메시지 접두사·query/params 속성으로도 판별한다
  if (isDrizzleQueryError(err)) return `DB 쿼리 실패: ${err.cause?.message ?? 'unknown'}`.slice(0, 300);
  return String(err?.message ?? e).slice(0, 300);
}
