import { and, count, desc, eq, isNull, lt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../app.js';
import { schema } from '../../db/client.js';
import { notFound } from '../../lib/errors.js';
import { notificationVisible } from '../../lib/blocks.js';
import { NOTIFICATION_TEXT, type NotificationType } from '../../lib/notify.js';
import { decodeCursor, idParam, pageQuery, toPage } from '../../lib/pagination.js';
import { me, requireAuth } from '../auth/plugin.js';
import { unreadSummary } from '../auth/routes.js';

type Row = typeof schema.notifications.$inferSelect;

function toTarget(n: Row) {
  if (n.type === 'MATCH') return { kind: 'match' as const, id: n.matchId ?? 0, postId: n.postId };
  if (n.type === 'MESSAGE') return { kind: 'conversation' as const, id: n.conversationId ?? 0, postId: n.postId };
  return { kind: 'comment' as const, id: n.commentId ?? 0, postId: n.postId };
}

export async function notificationRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  app.get('/notifications', { preHandler: requireAuth }, async (req) => {
    const q = pageQuery.parse(req.query);
    const userId = me(req).id;
    const cursor = decodeCursor(q.cursor);
    const rows = await db
      .select()
      .from(schema.notifications)
      .where(and(eq(schema.notifications.userId, userId), notificationVisible(userId), cursor ? lt(schema.notifications.id, cursor) : undefined))
      .orderBy(desc(schema.notifications.id))
      .limit(q.limit + 1);
    const page = toPage(rows, q.limit);
    // 알림 센터 배지: MESSAGE 알림을 포함한 읽지 않은 전체 알림 수
    const [unread] = await db
      .select({ c: count() })
      .from(schema.notifications)
      .where(and(eq(schema.notifications.userId, userId), isNull(schema.notifications.readAt), notificationVisible(userId)));
    return {
      items: page.items.map((n) => ({
        id: n.id,
        type: n.type,
        text: NOTIFICATION_TEXT[n.type as NotificationType],
        createdAt: n.createdAt,
        readAt: n.readAt,
        target: toTarget(n),
      })),
      unreadCount: unread?.c ?? 0,
      nextCursor: page.nextCursor,
    };
  });

  app.get('/notifications/unread-count', { preHandler: requireAuth }, async (req) => unreadSummary(ctx, me(req).id));

  app.post('/notifications/read-all', { preHandler: requireAuth }, async (req, reply) => {
    await db.update(schema.notifications).set({ readAt: new Date() }).where(and(eq(schema.notifications.userId, me(req).id), isNull(schema.notifications.readAt)));
    return reply.status(204).send();
  });

  app.post('/notifications/:id/read', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const res = await db
      .update(schema.notifications)
      .set({ readAt: new Date() })
      .where(and(eq(schema.notifications.id, id), eq(schema.notifications.userId, me(req).id)))
      .returning({ id: schema.notifications.id });
    if (!res.length) throw notFound('알림을 찾을 수 없습니다.');
    return reply.status(204).send();
  });
}
