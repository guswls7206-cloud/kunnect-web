import { z } from 'zod';
import { badRequest } from './errors.js';

export const idParam = z.object({ id: z.coerce.number().int().positive() });

export const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(100).optional(),
});

/** 커서는 마지막 항목 id 를 감싼 불투명 문자열이다. */
function encodeCursor(id: number): string {
  return Buffer.from(String(id)).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): number | undefined {
  if (!cursor) return undefined;
  const n = Number(Buffer.from(cursor, 'base64url').toString());
  if (!Number.isInteger(n) || n <= 0) throw badRequest('VALIDATION_ERROR', '잘못된 cursor 입니다.');
  return n;
}

/** limit+1 개를 조회한 결과를 페이지로 자른다. */
export function toPage<T extends { id: number }>(rows: T[], limit: number) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? encodeCursor(last.id) : null };
}
