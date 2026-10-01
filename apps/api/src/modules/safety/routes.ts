import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { schema } from '../../db/client.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { me, requireAuth } from '../auth/plugin.js';

const REASONS = ['SPAM', 'HARASSMENT', 'PRIVACY', 'FAKE', 'OTHER'] as const;
const SNAPSHOT_MESSAGES = 20; // 메시지 신고 시 저장할 최근 대화 건수(N, 제안값)

export async function safetyRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  async function isDeletedUser(userId: number) {
    const [u] = await db.select({ status: schema.users.status }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    return !u || u.status === 'DELETED';
  }

  app.get('/blocks', { preHandler: requireAuth }, async (req) => {
    const rows = await db
      .select({ userId: schema.blocks.blockedId, nickname: schema.users.nickname, createdAt: schema.blocks.createdAt })
      .from(schema.blocks)
      .innerJoin(schema.users, eq(schema.users.id, schema.blocks.blockedId))
      .where(eq(schema.blocks.blockerId, me(req).id))
      .orderBy(desc(schema.blocks.createdAt))
      .limit(200); // 상한(차단 목록은 보통 짧다)
    return { items: rows };
  });

  app.post('/blocks', { preHandler: requireAuth, config: ctx.rl(30, 3600_000) }, async (req, reply) => {
    const { userId } = z.object({ userId: z.number().int().positive() }).parse(req.body);
    const user = me(req);
    if (userId === user.id) throw badRequest('SELF_BLOCK', '자기 자신은 차단할 수 없습니다.');
    const [target] = await db.select({ id: schema.users.id }).from(schema.users).where(and(eq(schema.users.id, userId), eq(schema.users.status, 'ACTIVE'))).limit(1);
    if (!target) throw notFound('사용자를 찾을 수 없습니다.');
    await db.insert(schema.blocks).values({ blockerId: user.id, blockedId: userId }).onConflictDoNothing();
    return reply.status(204).send();
  });

  app.delete('/blocks/:userId', { preHandler: requireAuth }, async (req, reply) => {
    const { userId } = z.object({ userId: z.coerce.number().int().positive() }).parse(req.params);
    await db.delete(schema.blocks).where(and(eq(schema.blocks.blockerId, me(req).id), eq(schema.blocks.blockedId, userId)));
    return reply.status(204).send();
  });

  app.post('/reports', { preHandler: requireAuth, config: ctx.rl(10, 3600_000) }, async (req, reply) => {
    const body = z
      .object({
        targetType: z.enum(['POST', 'COMMENT', 'MESSAGE', 'USER']),
        targetId: z.number().int().positive(),
        reason: z.enum(REASONS),
        detail: z.string().trim().max(200).optional(),
      })
      .parse(req.body);
    const user = me(req);
    let targetUserId: number;
    let snapshot: Record<string, unknown>;
    if (body.targetType === 'POST') {
      const [p] = await db.select().from(schema.posts).where(eq(schema.posts.id, body.targetId)).limit(1);
      if (!p) throw notFound('신고 대상을 찾을 수 없습니다.');
      // 탈퇴한 사용자의 글(익명화·CLOSED)은 조치할 대상이 없다
      if (await isDeletedUser(p.authorId)) throw notFound('신고 대상을 찾을 수 없습니다.');
      targetUserId = p.authorId;
      snapshot = { title: p.title, description: p.description, storagePlace: p.storagePlace, status: p.status };
    } else if (body.targetType === 'COMMENT') {
      const [c] = await db.select().from(schema.comments).where(eq(schema.comments.id, body.targetId)).limit(1);
      // 사용자에게 보이지 않는 댓글(숨김/삭제)은 신고할 수 없다 — 볼 수 없는 내용의 snapshot 이 남지 않게 한다
      if (!c || c.status !== 'VISIBLE') throw notFound('신고 대상을 찾을 수 없습니다.');
      if (await isDeletedUser(c.authorId)) throw notFound('신고 대상을 찾을 수 없습니다.');
      targetUserId = c.authorId;
      snapshot = { postId: c.postId, body: c.body };
    } else if (body.targetType === 'MESSAGE') {
      const [m] = await db.select().from(schema.messages).where(and(eq(schema.messages.id, body.targetId), isNull(schema.messages.deletedAt))).limit(1);
      if (!m) throw notFound('신고 대상을 찾을 수 없습니다.');
      const [conv] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, m.conversationId)).limit(1);
      // 대화 참여자만 해당 메시지를 신고할 수 있다
      if (!conv || (conv.userAId !== user.id && conv.userBId !== user.id)) throw notFound('신고 대상을 찾을 수 없습니다.');
      targetUserId = m.senderId;
      const recent = await db
        .select({ id: schema.messages.id, senderId: schema.messages.senderId, body: schema.messages.body, createdAt: schema.messages.createdAt })
        .from(schema.messages)
        .where(eq(schema.messages.conversationId, m.conversationId))
        .orderBy(desc(schema.messages.id))
        .limit(SNAPSHOT_MESSAGES);
      snapshot = { conversationId: m.conversationId, messageId: m.id, recent: recent.reverse() };
    } else {
      const [u] = await db.select().from(schema.users).where(eq(schema.users.id, body.targetId)).limit(1);
      if (!u || u.status !== 'ACTIVE') throw notFound('신고 대상을 찾을 수 없습니다.');
      targetUserId = u.id;
      snapshot = { nickname: u.nickname };
    }
    if (targetUserId === user.id) throw badRequest('SELF_REPORT', '자기 자신이 작성한 내용은 신고할 수 없습니다.');
    const ins = await db
      .insert(schema.reports)
      .values({ reporterId: user.id, targetType: body.targetType, targetId: body.targetId, targetUserId, reason: body.reason, detail: body.detail, snapshot })
      .onConflictDoNothing()
      .returning({ id: schema.reports.id });
    if (!ins[0]) throw conflict('ALREADY_REPORTED', '이미 신고한 대상입니다.');
    return reply.status(201).send({ id: ins[0].id });
  });
}
