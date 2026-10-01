/** PostgreSQL 오류 코드. Drizzle 은 원인 오류를 cause 에 감싸므로 양쪽을 모두 확인한다. */
export function pgCode(e: unknown): string | undefined {
  const x = e as { code?: string; cause?: { code?: string } } | null;
  return x?.code ?? x?.cause?.code;
}

/** 위반된 제약/인덱스 이름(unique 위반 등)을 돌려준다. */
export function pgConstraint(e: unknown): string | undefined {
  const x = e as { constraint?: string; cause?: { constraint?: string } } | null;
  return x?.constraint ?? x?.cause?.constraint;
}

export const isUniqueViolation = (e: unknown) => pgCode(e) === '23505';

/** LIKE 패턴의 와일드카드(%, _, 역슬래시) 이스케이프 */
export const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
