import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { isBlockedEither } from './blocks.js';
import { schema } from '../db/client.js';

export type NotificationType = 'MATCH' | 'COMMENT' | 'REPLY' | 'MESSAGE';

/** 알림 문구는 서버가 생성한다. 물건 상세·위치·메시지 본문은 담지 않는다(README 10절). */
export const NOTIFICATION_TEXT: Record<NotificationType, string> = {
  MATCH: '분실하신 물건과 비슷한 물건의 글이 작성되었습니다. 확인해 보세요.',
  COMMENT: '내 글에 새 댓글이 달렸습니다.',
  REPLY: '내 댓글에 답글이 달렸습니다.',
  MESSAGE: '새 쪽지가 도착했습니다.',
};

const SETTING_BY_TYPE = {
  MATCH: 'notifyMatch',
  COMMENT: 'notifyComment',
  REPLY: 'notifyComment',
  MESSAGE: 'notifyMessage',
} as const;

export interface NotifyInput {
  userId: number;
  /** 알림을 유발한 사용자. 수신자와 차단 관계(어느 방향이든)면 알림을 만들지 않는다. */
  actorId?: number;
  type: NotificationType;
  postId?: number;
  matchId?: number;
  commentId?: number;
  conversationId?: number;
}

/** 수신자의 알림 설정이 꺼져 있으면 생성하지 않는다. 생성되면 true. */
export async function notify(db: Db, input: NotifyInput): Promise<boolean> {
  if (input.actorId !== undefined && (await isBlockedEither(db, input.actorId, input.userId))) return false;
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, input.userId)).limit(1);
  if (!u || u.status !== 'ACTIVE' || !u[SETTING_BY_TYPE[input.type]]) return false;
  if (input.type === 'MESSAGE' && input.conversationId) {
    // 같은 대화의 읽지 않은 쪽지 알림이 이미 있으면 중복 생성하지 않는다(알림 폭주 방지)
    const [dup] = await db
      .select({ id: schema.notifications.id })
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.userId, input.userId),
          eq(schema.notifications.type, 'MESSAGE'),
          eq(schema.notifications.conversationId, input.conversationId),
          isNull(schema.notifications.readAt),
        ),
      )
      .limit(1);
    if (dup) return false;
  }
  await db.insert(schema.notifications).values({
    userId: input.userId,
    type: input.type,
    postId: input.postId,
    matchId: input.matchId,
    commentId: input.commentId,
    conversationId: input.conversationId,
  });
  return true;
}
