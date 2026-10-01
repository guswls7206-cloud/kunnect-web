import { and, eq, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { schema } from '../db/client.js';

/** 두 사용자 사이에 어느 방향으로든 차단이 있으면 true. */
export async function isBlockedEither(db: Db, a: number, b: number): Promise<boolean> {
  const [row] = await db
    .select({ x: schema.blocks.blockerId })
    .from(schema.blocks)
    .where(
      or(
        and(eq(schema.blocks.blockerId, a), eq(schema.blocks.blockedId, b)),
        and(eq(schema.blocks.blockerId, b), eq(schema.blocks.blockedId, a)),
      ),
    )
    .limit(1);
  return !!row;
}

/** viewer 와 어느 방향으로든 차단 관계인 사용자 id 집합. */
export async function blockedUserIds(db: Db, viewerId: number): Promise<Set<number>> {
  const rows = await db
    .select({ a: schema.blocks.blockerId, b: schema.blocks.blockedId })
    .from(schema.blocks)
    .where(or(eq(schema.blocks.blockerId, viewerId), eq(schema.blocks.blockedId, viewerId)));
  return new Set(rows.map((r) => (r.a === viewerId ? r.b : r.a)));
}

/**
 * SQL 조건: userIdExpr(예: posts.author_id)가 viewer 와 차단 관계(양방향)가 아님.
 * [사용자 결정] 차단 시 프로필·글 비노출, [가정/제안 A27] 양방향.
 */
export function notBlockedWith(viewerId: number, userIdExpr: SQL | AnyColumn): SQL {
  return sql`not exists (select 1 from blocks bk where (bk.blocker_id = ${viewerId} and bk.blocked_id = ${userIdExpr}) or (bk.blocked_id = ${viewerId} and bk.blocker_id = ${userIdExpr}))`;
}

/**
 * SQL 조건: 알림이 차단 상대와 관련되지 않음.
 * COMMENT/REPLY → 댓글 작성자, MATCH → 매칭의 상대 글 작성자, MESSAGE → 대화 상대.
 */
export function notificationVisible(viewerId: number): SQL {
  const n = schema.notifications;
  return sql`(
    (${n.type} in ('COMMENT', 'REPLY') and ${n.commentId} is not null and not exists (
       select 1 from comments cc where cc.id = ${n.commentId} and not (${notBlockedWith(viewerId, sql`cc.author_id`)})))
    or (${n.type} = 'MATCH' and ${n.matchId} is not null and not exists (
       select 1 from matches mm join posts pp on pp.id in (mm.lost_post_id, mm.found_post_id) and pp.author_id <> ${viewerId}
        where mm.id = ${n.matchId} and not (${notBlockedWith(viewerId, sql`pp.author_id`)})))
    or (${n.type} = 'MESSAGE' and ${n.conversationId} is not null and not exists (
       select 1 from conversations cv where cv.id = ${n.conversationId}
          and not (${notBlockedWith(viewerId, sql`case when cv.user_a_id = ${viewerId} then cv.user_b_id else cv.user_a_id end`)})))
    or (${n.type} not in ('COMMENT', 'REPLY', 'MATCH', 'MESSAGE'))
    or (${n.type} in ('COMMENT', 'REPLY') and ${n.commentId} is null)
    or (${n.type} = 'MATCH' and ${n.matchId} is null)
    or (${n.type} = 'MESSAGE' and ${n.conversationId} is null)
  )`;
}
