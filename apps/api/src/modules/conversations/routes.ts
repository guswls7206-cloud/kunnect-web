import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { schema } from '../../db/client.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { isBlockedEither } from '../../lib/blocks.js';
import { notify } from '../../lib/notify.js';
import { idParam } from '../../lib/pagination.js';
import { me, requireAuth } from '../auth/plugin.js';
import { latestHandovers, retryOnConflict } from '../handovers/service.js';

// 쪽지는 텍스트 전용 최대 1,000자. 연락처 패턴 마스킹·경고는 하지 않는다(README 17번 확정).
const MESSAGE_MAX = 1000;
const bodyField = z.string().trim().min(1, '내용을 입력해 주세요.').max(MESSAGE_MAX, `쪽지는 ${MESSAGE_MAX}자 이하여야 합니다.`);
const MESSAGE_TYPES = ['TEXT', 'VERIFY_QUESTION', 'VERIFY_ANSWER'] as const;

type Conv = typeof schema.conversations.$inferSelect;

const pairOf = (a: number, b: number) => (a < b ? ([a, b] as const) : ([b, a] as const));

export function serializeMessage(m: typeof schema.messages.$inferSelect) {
  return { id: m.id, conversationId: m.conversationId, senderId: m.senderId, type: m.type, body: m.body, postId: m.postId, createdAt: m.createdAt };
}

export async function conversationRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  /** 참여자만 접근 가능. 대화와 내 member 행을 돌려준다. */
  async function loadMine(convId: number, userId: number) {
    const [conv] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, convId)).limit(1);
    if (!conv || (conv.userAId !== userId && conv.userBId !== userId)) throw notFound('대화를 찾을 수 없습니다.');
    const [member] = await db
      .select()
      .from(schema.conversationMembers)
      .where(and(eq(schema.conversationMembers.conversationId, convId), eq(schema.conversationMembers.userId, userId)))
      .limit(1);
    if (!member) throw notFound('대화를 찾을 수 없습니다.');
    // 내가 삭제해 쪽지함에서 숨겨진 대화는 직접 접근도 404(되살아나기 전까지)
    if (member.deletedAt !== null && member.leftAt !== null) throw notFound('대화를 찾을 수 없습니다.');
    return { conv, member, otherId: conv.userAId === userId ? conv.userBId : conv.userAId };
  }

  /** 참여자 확인만(삭제로 숨겨진 대화도 허용) — DELETE 의 멱등 처리용. 참여자가 아니면 404. */
  async function loadMineAny(convId: number, userId: number) {
    const [conv] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, convId)).limit(1);
    if (!conv || (conv.userAId !== userId && conv.userBId !== userId)) throw notFound('대화를 찾을 수 없습니다.');
    return { conv, otherId: conv.userAId === userId ? conv.userBId : conv.userAId };
  }

  async function userIsDeleted(userId: number): Promise<boolean> {
    const [u] = await db.select({ status: schema.users.status }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    return u?.status === 'DELETED';
  }

  async function buildItems(convs: Conv[], userId: number) {
    if (!convs.length) return [];
    const ids = convs.map((c) => c.id);
    const members = await db
      .select()
      .from(schema.conversationMembers)
      .where(and(inArray(schema.conversationMembers.conversationId, ids), eq(schema.conversationMembers.userId, userId)));
    const otherIds = convs.map((c) => (c.userAId === userId ? c.userBId : c.userAId));
    const others = await db.select({ id: schema.users.id, nickname: schema.users.nickname, status: schema.users.status }).from(schema.users).where(inArray(schema.users.id, otherIds));
    const last = await db.execute<{ conversation_id: number; created_at: Date; type: string }>(sql`
      select distinct on (m.conversation_id) m.conversation_id, m.created_at, m.type
        from messages m
        join conversation_members cm on cm.conversation_id = m.conversation_id and cm.user_id = ${userId}
       where m.conversation_id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) and m.deleted_at is null and m.id > cm.cleared_message_id
       order by m.conversation_id, m.id desc`);
    const unread = await db.execute<{ conversation_id: number; c: number }>(sql`
      select m.conversation_id, count(*)::int as c from messages m
        join conversation_members cm on cm.conversation_id = m.conversation_id and cm.user_id = ${userId}
       where m.conversation_id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
         and m.sender_id <> ${userId} and m.deleted_at is null and m.id > cm.last_read_message_id and m.id > cm.cleared_message_id
       group by m.conversation_id`);
    const ctxPost = await db.execute<{ conversation_id: number; id: number; title: string }>(sql`
      select distinct on (m.conversation_id) m.conversation_id, p.id, p.title
        from messages m join posts p on p.id = m.post_id
        join conversation_members cm on cm.conversation_id = m.conversation_id and cm.user_id = ${userId}
       where m.conversation_id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) and m.id > cm.cleared_message_id
       order by m.conversation_id, m.id desc`);
    const blocks = await db
      .select()
      .from(schema.blocks)
      .where(or(and(eq(schema.blocks.blockerId, userId), inArray(schema.blocks.blockedId, otherIds)), and(eq(schema.blocks.blockedId, userId), inArray(schema.blocks.blockerId, otherIds))));
    const blockedWith = new Set(blocks.map((b) => (b.blockerId === userId ? b.blockedId : b.blockerId)));
    const handovers = await latestHandovers(db, convs, userId);
    return convs.map((c, i) => {
      const otherId = otherIds[i]!;
      const lm = last.rows.find((r) => r.conversation_id === c.id);
      const post = ctxPost.rows.find((r) => r.conversation_id === c.id);
      return {
        id: c.id,
        other: { id: otherId, nickname: others.find((o) => o.id === otherId)?.nickname ?? '알 수 없음' },
        lastMessage: lm ? { createdAt: lm.created_at, type: lm.type } : null,
        unread: unread.rows.find((r) => r.conversation_id === c.id)?.c ?? 0,
        muted: members.find((m) => m.conversationId === c.id)?.muted ?? false,
        readOnly: blockedWith.has(otherId) || others.find((o) => o.id === otherId)?.status === 'DELETED',
        postContext: post ? { id: post.id, title: post.title } : null,
        handover: handovers.get(c.id) ?? null,
      };
    });
  }

  async function appendMessage(conv: Conv, senderId: number, otherId: number, input: { type: string; body: string; postId?: number | null }) {
    // 메시지 저장·대화 갱신·상대 쪽지함 복귀를 한 트랜잭션으로 처리한다(중간 실패 시 일부만 반영되는 상태 방지)
    // 대화 삭제/글 삭제와 겹치면 교착(40P01)이 날 수 있어 통째로 재시도한다
    const msg = await retryOnConflict(() => db.transaction(async (tx) => {
      const [m] = await tx
        .insert(schema.messages)
        .values({ conversationId: conv.id, senderId, type: input.type, body: input.body, postId: input.postId ?? null })
        .returning();
      // 동시 전송에서도 마지막 메시지 시각이 뒤로 가지 않도록 greatest 사용
      await tx.update(schema.conversations).set({ lastMessageAt: sql`greatest(${schema.conversations.lastMessageAt}, ${m!.createdAt})` }).where(eq(schema.conversations.id, conv.id));
      // 상대가 대화에서 나갔어도 새 쪽지가 오면 다시 쪽지함에 나타난다
      await tx
        .update(schema.conversationMembers)
        .set({ leftAt: null })
        .where(and(eq(schema.conversationMembers.conversationId, conv.id), eq(schema.conversationMembers.userId, otherId)));
      return m!;
    }));
    const [otherMember] = await db
      .select()
      .from(schema.conversationMembers)
      .where(and(eq(schema.conversationMembers.conversationId, conv.id), eq(schema.conversationMembers.userId, otherId)))
      .limit(1);
    // actorId: 수신자와 차단 관계면 알림을 만들지 않는다(쪽지 전송 자체가 막히지만 경쟁 상태·향후 경로 대비 이중 방어)
    if (!otherMember?.muted) await notify(db, { userId: otherId, actorId: senderId, type: 'MESSAGE', conversationId: conv.id, postId: input.postId ?? undefined });
    return msg;
  }

  app.post('/conversations', { preHandler: requireAuth, config: ctx.rl(10, 24 * 3600_000) }, async (req, reply) => {
    const user = me(req);
    const body = z
      .object({ targetUserId: z.number().int().positive().optional(), postId: z.number().int().positive().optional(), body: bodyField })
      .refine((b) => b.targetUserId !== undefined || b.postId !== undefined, { message: 'targetUserId 또는 postId 가 필요합니다.' })
      .parse(req.body);
    let targetId = body.targetUserId;
    if (body.postId !== undefined) {
      const [post] = await db.select({ id: schema.posts.id, authorId: schema.posts.authorId }).from(schema.posts).where(eq(schema.posts.id, body.postId)).limit(1);
      if (!post) throw notFound('글을 찾을 수 없습니다.');
      if (targetId !== undefined && targetId !== post.authorId) throw badRequest('VALIDATION_ERROR', 'targetUserId 가 글 작성자와 다릅니다.');
      targetId = post.authorId;
    }
    if (targetId === undefined) throw badRequest('VALIDATION_ERROR', '대상이 필요합니다.');
    if (targetId === user.id) throw badRequest('SELF_MESSAGE', '자기 자신에게는 쪽지를 보낼 수 없습니다.');
    const [target] = await db.select({ id: schema.users.id, status: schema.users.status }).from(schema.users).where(eq(schema.users.id, targetId)).limit(1);
    if (!target || target.status !== 'ACTIVE') throw notFound('사용자를 찾을 수 없습니다.');
    // 차단 사실은 상대에게 구체적으로 알리지 않는다(중립 문구)
    if (await isBlockedEither(db, user.id, targetId)) throw forbidden('쪽지를 보낼 수 없습니다.', 'BLOCKED');

    const [a, b] = pairOf(user.id, targetId);
    // 대화 행과 참여자 행을 한 트랜잭션으로: 중간 실패나 동시 생성에서도 참여자 행이 항상 갖춰진다
    const { conv, created } = await db.transaction(async (tx) => {
      let c = (await tx.select().from(schema.conversations).where(and(eq(schema.conversations.userAId, a), eq(schema.conversations.userBId, b))).limit(1))[0];
      let isNew = false;
      if (!c) {
        const ins = await tx.insert(schema.conversations).values({ userAId: a, userBId: b }).onConflictDoNothing().returning();
        c = ins[0] ?? (await tx.select().from(schema.conversations).where(and(eq(schema.conversations.userAId, a), eq(schema.conversations.userBId, b))).limit(1))[0];
        isNew = !!ins[0];
      }
      await tx.insert(schema.conversationMembers).values([{ conversationId: c!.id, userId: a }, { conversationId: c!.id, userId: b }]).onConflictDoNothing();
      return { conv: c!, created: isNew };
    });
    // 내가 이전에 나갔다면 다시 참여
    await db
      .update(schema.conversationMembers)
      .set({ leftAt: null })
      .where(and(eq(schema.conversationMembers.conversationId, conv.id), eq(schema.conversationMembers.userId, user.id)));
    const msg = await appendMessage(conv, user.id, targetId, { type: 'TEXT', body: body.body, postId: body.postId });
    const [item] = await buildItems([conv], user.id);
    return reply.status(created ? 201 : 200).send({ conversation: item, message: serializeMessage(msg) });
  });

  app.get('/conversations', { preHandler: requireAuth }, async (req) => {
    const user = me(req);
    const q = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20), cursor: z.string().max(100).optional() }).parse(req.query);
    // 커서: "<lastMessageAt epoch ms>_<id>"
    let after: { ms: number; id: number } | null = null;
    if (q.cursor) {
      const parts = Buffer.from(q.cursor, 'base64url').toString().split('_').map(Number);
      const [ms, id] = parts;
      // 유효한 시각 범위·양의 정수 id 만 허용(거대한 값이 Date/SQL 오류로 500 이 되는 것을 막는다)
      if (parts.length !== 2 || !Number.isInteger(ms) || ms! < 0 || ms! > 8.64e15 || !Number.isInteger(id) || id! <= 0) throw badRequest('VALIDATION_ERROR', '잘못된 cursor 입니다.');
      after = { ms: ms!, id: id! };
    }
    const rows = await db
      .select({ c: schema.conversations })
      .from(schema.conversations)
      .innerJoin(schema.conversationMembers, and(eq(schema.conversationMembers.conversationId, schema.conversations.id), eq(schema.conversationMembers.userId, user.id)))
      .where(
        and(
          isNull(schema.conversationMembers.leftAt),
          after
            ? or(
                lt(schema.conversations.lastMessageAt, new Date(after.ms)),
                and(eq(schema.conversations.lastMessageAt, new Date(after.ms)), lt(schema.conversations.id, after.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(schema.conversations.lastMessageAt), desc(schema.conversations.id))
      .limit(q.limit + 1);
    const hasMore = rows.length > q.limit;
    const convs = rows.slice(0, q.limit).map((r) => r.c);
    const lastConv = convs[convs.length - 1];
    return {
      items: await buildItems(convs, user.id),
      nextCursor: hasMore && lastConv ? Buffer.from(`${lastConv.lastMessageAt.getTime()}_${lastConv.id}`).toString('base64url') : null,
    };
  });

  app.get('/conversations/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { conv } = await loadMine(id, me(req).id);
    const [item] = await buildItems([conv], me(req).id);
    return item;
  });

  app.get('/conversations/:id/messages', { preHandler: requireAuth }, async (req) => {
    const { id } = idParam.parse(req.params);
    const q = z
      .object({
        afterId: z.coerce.number().int().min(0).optional(),
        beforeId: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(1).max(50).default(30),
      })
      .parse(req.query);
    const { member } = await loadMine(id, me(req).id);
    // 내가 삭제한 시점까지의 메시지는 숨긴다
    const base = and(eq(schema.messages.conversationId, id), isNull(schema.messages.deletedAt), sql`${schema.messages.id} > ${member.clearedMessageId}`);
    if (q.afterId !== undefined) {
      // 폴링: 새 메시지(오름차순)
      const rows = await db.select().from(schema.messages).where(and(base, sql`${schema.messages.id} > ${q.afterId}`)).orderBy(asc(schema.messages.id)).limit(q.limit);
      return { items: rows.map(serializeMessage) };
    }
    const rows = await db
      .select()
      .from(schema.messages)
      .where(and(base, q.beforeId ? lt(schema.messages.id, q.beforeId) : undefined))
      .orderBy(desc(schema.messages.id))
      .limit(q.limit);
    return { items: rows.reverse().map(serializeMessage) };
  });

  app.post('/conversations/:id/messages', { preHandler: requireAuth, config: ctx.rl(30, 60_000) }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const user = me(req);
    const body = z
      .object({ type: z.enum(MESSAGE_TYPES).default('TEXT'), body: bodyField, postId: z.number().int().positive().optional() })
      .parse(req.body);
    const { conv, otherId } = await loadMine(id, user.id);
    // 차단된 대화는 읽기 전용. 차단 사실은 드러내지 않는 일반 오류로 응답한다
    const [otherUser] = await db.select({ status: schema.users.status }).from(schema.users).where(eq(schema.users.id, otherId)).limit(1);
    if (otherUser?.status === 'DELETED' || (await isBlockedEither(db, user.id, otherId))) throw conflict('READ_ONLY', '이 대화에는 더 이상 쪽지를 보낼 수 없습니다.');
    if (body.postId !== undefined) {
      const [p] = await db.select({ id: schema.posts.id }).from(schema.posts).where(eq(schema.posts.id, body.postId)).limit(1);
      if (!p) throw badRequest('VALIDATION_ERROR', '존재하지 않는 글입니다.');
    }
    const msg = await appendMessage(conv, user.id, otherId, body);
    return reply.status(201).send({ message: serializeMessage(msg) });
  });

  app.post('/conversations/:id/read', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { lastMessageId } = z.object({ lastMessageId: z.number().int().min(0) }).parse(req.body);
    const user = me(req);
    await loadMine(id, user.id);
    const [mx] = await db.select({ m: sql<number>`coalesce(max(${schema.messages.id}), 0)::int` }).from(schema.messages).where(eq(schema.messages.conversationId, id));
    const target = Math.min(lastMessageId, mx?.m ?? 0);
    // 단조 증가만 허용
    await db
      .update(schema.conversationMembers)
      .set({ lastReadMessageId: sql`greatest(${schema.conversationMembers.lastReadMessageId}, ${target})` })
      .where(and(eq(schema.conversationMembers.conversationId, id), eq(schema.conversationMembers.userId, user.id)));
    // 해당 대화의 쪽지 알림도 읽음 처리
    await db
      .update(schema.notifications)
      .set({ readAt: new Date() })
      .where(and(eq(schema.notifications.userId, user.id), eq(schema.notifications.conversationId, id), isNull(schema.notifications.readAt)));
    return reply.status(204).send();
  });

  app.patch('/conversations/:id/settings', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { muted } = z.object({ muted: z.boolean() }).parse(req.body);
    const user = me(req);
    await loadMine(id, user.id);
    await db.update(schema.conversationMembers).set({ muted }).where(and(eq(schema.conversationMembers.conversationId, id), eq(schema.conversationMembers.userId, user.id)));
    return reply.status(204).send();
  });

  /**
   * 쪽지함에서 대화 삭제(사용자별 삭제) [가정/제안 A31].
   * - 내 쪽지함에서만 숨기고 삭제 시점까지의 메시지를 나에게만 숨긴다(상대는 영향 없음). 멱등.
   * - 상대가 새 쪽지를 보내거나 내가 다시 쪽지를 보내면 되살아나며 삭제 이후 메시지만 보인다.
   * - 양쪽 모두 삭제했고 양쪽에 보일 메시지가 없으면(또는 상대가 탈퇴했으면) 대화·메시지를 즉시 영구 삭제한다.
   * - 진행 중 인수 요청이 있으면 409 ACTIVE_HANDOVER. 단 읽기 전용(차단/상대 탈퇴) 대화는 자동 거절 후 삭제한다.
   * 잠금 순서: 대화 -> 참여자 행(사용자 id 순) -> 인수 요청. 충돌(40P01/40001)은 재시도.
   */
  app.delete('/conversations/:id', { preHandler: requireAuth, config: ctx.rl(60, 3600_000) }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const user = me(req);
    const { conv, otherId } = await loadMineAny(id, user.id);
    const peerDeleted = await userIsDeleted(otherId);
    const readOnly = peerDeleted || (await isBlockedEither(db, user.id, otherId));
    await retryOnConflict(() =>
      db.transaction(async (tx) => {
        await tx.select({ id: schema.conversations.id }).from(schema.conversations).where(eq(schema.conversations.id, conv.id)).for('update');
        const members = await tx
          .select()
          .from(schema.conversationMembers)
          .where(eq(schema.conversationMembers.conversationId, conv.id))
          .orderBy(schema.conversationMembers.userId)
          .for('update');
        const mine = members.find((m) => m.userId === user.id);
        if (!mine) return; // 상대가 먼저 영구 삭제를 마친 경우 등(멱등)
        const other = members.find((m) => m.userId === otherId);
        const [mx] = await tx.select({ m: sql<number>`coalesce(max(${schema.messages.id}), 0)::int` }).from(schema.messages).where(eq(schema.messages.conversationId, conv.id));
        const maxId = mx?.m ?? 0;
        const alreadyHidden = mine.deletedAt !== null && mine.leftAt !== null && mine.clearedMessageId >= maxId;
        if (!alreadyHidden) {
          const active = await tx
            .select({ id: schema.handoverRequests.id })
            .from(schema.handoverRequests)
            .where(and(eq(schema.handoverRequests.conversationId, conv.id), inArray(schema.handoverRequests.status, ['REQUESTED', 'VERIFIED'])))
            .for('update');
          if (active.length) {
            if (!readOnly) throw conflict('ACTIVE_HANDOVER', '진행 중인 인수 요청이 있어 삭제할 수 없습니다. 먼저 인수를 완료하거나 거절해 주세요.');
            await tx.update(schema.handoverRequests).set({ status: 'REJECTED' }).where(inArray(schema.handoverRequests.id, active.map((a) => a.id)));
          }
          const now = new Date();
          await tx
            .update(schema.conversationMembers)
            .set({ deletedAt: now, leftAt: now, clearedMessageId: maxId, lastReadMessageId: sql`greatest(${schema.conversationMembers.lastReadMessageId}, ${maxId})` })
            .where(and(eq(schema.conversationMembers.conversationId, conv.id), eq(schema.conversationMembers.userId, user.id)));
          await tx
            .delete(schema.notifications)
            .where(and(eq(schema.notifications.userId, user.id), eq(schema.notifications.type, 'MESSAGE'), eq(schema.notifications.conversationId, conv.id)));
        }
        // 양쪽 모두 삭제했고 볼 메시지가 없으면(상대 탈퇴 포함) 영구 삭제: 메시지·인수 요청·알림·참여자 행은 cascade
        const otherEmpty = !other || (other.deletedAt !== null && other.clearedMessageId >= maxId);
        if (peerDeleted || otherEmpty) await tx.delete(schema.conversations).where(eq(schema.conversations.id, conv.id));
      }),
    );
    return reply.status(204).send();
  });

  app.post('/conversations/:id/leave', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const user = me(req);
    await loadMine(id, user.id);
    await db.update(schema.conversationMembers).set({ leftAt: new Date() }).where(and(eq(schema.conversationMembers.conversationId, id), eq(schema.conversationMembers.userId, user.id)));
    return reply.status(204).send();
  });
}
