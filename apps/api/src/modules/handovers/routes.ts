import { and, count, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { schema } from '../../db/client.js';
import { isBlockedEither } from '../../lib/blocks.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { idParam } from '../../lib/pagination.js';
import { me, requireAuth } from '../auth/plugin.js';
import { ACTIVE_POST, closeMatchesOnReturn, inferCounterpart, isActiveHandoverViolation, loadHandoverContext, retryOnConflict, rolesOf, serializeHandover, type Executor } from './service.js';

/** 대화당 인수 요청 총 상한(거절을 반복해 상대를 괴롭히는 것 방지) [가정/제안] */
const MAX_HANDOVERS_PER_CONVERSATION = 10;

/**
 * 인수 협의 상태 객체. 쪽지(Conversation)에 연결되며 별도 화면은 없다(README 15절).
 * 흐름: REQUESTED -> (습득자) VERIFIED -> 양측 complete -> COMPLETED(글 RETURNED)
 * 습득자 = 습득글 작성자(또는 분실글이 대상이면 그 글 작성자의 대화 상대).
 *
 * 무결성 규칙 [가정/제안]
 * - 상태 전이는 `UPDATE ... WHERE status = 기대값`(verify/reject) 또는 행 잠금 `FOR UPDATE`(complete/create)로 원자적이다.
 * - 한 대화에는 진행 중(REQUESTED/VERIFIED) 인수가 1건만 있고, 총 요청은 10건을 넘지 못한다.
 * - complete 는 멱등이다(같은 쪽 재확인·완료 후 재호출은 200, 시스템 메시지를 다시 만들지 않는다).
 * - 대상 글이 이미 종료(OPEN/MATCHED 아님)면 verify/complete 는 409 POST_CLOSED 이고, complete 는 인수를 REJECTED 로 취소한다.
 * - 쌍 대화는 다른 물건에도 재사용되므로 인수 완료가 대화를 읽기 전용으로 만들지 않는다.
 *   conversations.closed_at 은 "보존 시계 시작"일 뿐이며 최초 1회만 기록한다(재기록으로 삭제 시점을 늦추지 않는다).
 *   읽기 전용은 상대 탈퇴·차단으로만 결정한다.
 */
export async function handoverRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  /** 참여자만 접근. 차단·탈퇴로 읽기 전용인 대화에서는 상태를 바꿀 수 없다(409 READ_ONLY). */
  async function load(id: number, userId: number, opts: { write: boolean }) {
    const c = await loadHandoverContext(db, id);
    if (!c || (c.conv.userAId !== userId && c.conv.userBId !== userId)) throw notFound('인수 요청을 찾을 수 없습니다.');
    if (opts.write) await assertWritable(c.conv, userId);
    return c;
  }

  async function assertWritable(conv: typeof schema.conversations.$inferSelect, userId: number) {
    const otherId = conv.userAId === userId ? conv.userBId : conv.userAId;
    const [other] = await db.select({ status: schema.users.status }).from(schema.users).where(eq(schema.users.id, otherId)).limit(1);
    if (other?.status === 'DELETED' || (await isBlockedEither(db, userId, otherId))) {
      throw conflict('READ_ONLY', '이 대화에서는 더 이상 진행할 수 없습니다.');
    }
  }

  async function systemMessage(ex: Executor, conversationId: number, senderId: number, body: string) {
    await ex.insert(schema.messages).values({ conversationId, senderId, type: 'SYSTEM', body });
    await ex.update(schema.conversations).set({ lastMessageAt: new Date() }).where(eq(schema.conversations.id, conversationId));
  }

  const assertPostActive = (status: string) => {
    if (!ACTIVE_POST.includes(status)) throw conflict('POST_CLOSED', '종료된 글입니다.');
  };

  /**
   * 모든 변경 트랜잭션의 첫 단계. 잠금 순서를 "대화 → 인수 → 글"로 통일해 교착을 막고,
   * 같은 대화의 인수 요청 생성/전이를 직렬화한다.
   */
  async function lockConversation(ex: Executor, id: number) {
    await ex.select({ id: schema.conversations.id }).from(schema.conversations).where(eq(schema.conversations.id, id)).for('update');
  }

  async function lockPost(ex: Executor, id: number) {
    const [p] = await ex.select().from(schema.posts).where(eq(schema.posts.id, id)).for('update');
    if (!p) throw notFound('글을 찾을 수 없습니다.');
    return p;
  }

  app.get('/handovers/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = idParam.parse(req.params);
    const user = me(req);
    const { h, conv, post } = await load(id, user.id, { write: false });
    return serializeHandover(h, conv, post, user.id);
  });

  app.post('/conversations/:id/handover', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const user = me(req);
    const body = z.object({ postId: z.number().int().positive(), matchId: z.number().int().positive().optional() }).parse(req.body);
    const [conv] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, id)).limit(1);
    if (!conv || (conv.userAId !== user.id && conv.userBId !== user.id)) throw notFound('대화를 찾을 수 없습니다.');
    await assertWritable(conv, user.id);
    const [post] = await db.select().from(schema.posts).where(eq(schema.posts.id, body.postId)).limit(1);
    if (!post) throw notFound('글을 찾을 수 없습니다.');
    // 글 작성자는 대화 참여자 중 한 명이어야 한다
    if (post.authorId !== conv.userAId && post.authorId !== conv.userBId) throw badRequest('VALIDATION_ERROR', '이 대화와 관련 없는 글입니다.');
    if (body.matchId !== undefined) {
      // matchId 위조 방지: 매칭의 두 글 중 postId 가 있고, 두 글의 작성자가 이 대화의 두 참여자와 정확히 일치해야 한다
      const [m] = await db.select().from(schema.matches).where(eq(schema.matches.id, body.matchId)).limit(1);
      if (!m || (m.lostPostId !== post.id && m.foundPostId !== post.id)) throw notFound('매칭을 찾을 수 없습니다.');
      const authors = await db.select({ a: schema.posts.authorId }).from(schema.posts).where(inArray(schema.posts.id, [m.lostPostId, m.foundPostId]));
      const set = new Set(authors.map((x) => x.a));
      if (set.size !== 2 || !set.has(conv.userAId) || !set.has(conv.userBId)) throw notFound('매칭을 찾을 수 없습니다.');
    }
    // 같은 대화에서 동시에 요청이 와도 직렬화되도록 대화 행을 잠근 뒤, 글 상태(행 잠금)와 진행 중/총 건수를 같은 트랜잭션에서 검사한다(TOCTOU 제거)
    const h = await retryOnConflict(() => db.transaction(async (tx) => {
      await lockConversation(tx, id);
      assertPostActive((await lockPost(tx, body.postId)).status);
      const [active] = await tx
        .select({ id: schema.handoverRequests.id })
        .from(schema.handoverRequests)
        .where(and(eq(schema.handoverRequests.conversationId, id), inArray(schema.handoverRequests.status, ['REQUESTED', 'VERIFIED'])))
        .limit(1);
      if (active) throw conflict('ALREADY_REQUESTED', '이미 진행 중인 인수 요청이 있습니다.');
      const [total] = await tx.select({ n: count() }).from(schema.handoverRequests).where(eq(schema.handoverRequests.conversationId, id));
      if ((total?.n ?? 0) >= MAX_HANDOVERS_PER_CONVERSATION) {
        throw conflict('HANDOVER_LIMIT', '이 대화에서 시작할 수 있는 인수 요청 횟수를 넘었습니다.');
      }
      const [row] = await tx
        .insert(schema.handoverRequests)
        .values({ conversationId: id, postId: body.postId, matchId: body.matchId ?? null, requesterId: user.id })
        .returning();
      await systemMessage(tx, id, user.id, '인수 요청이 시작되었습니다.');
      return row!;
    })).catch((e: unknown) => {
      // 앱 수준 검사를 통과한 경합이 있어도 DB 부분 유니크 인덱스가 최후 방어선: 500 대신 409 로 변환
      if (isActiveHandoverViolation(e)) throw conflict('ALREADY_REQUESTED', '이미 진행 중인 인수 요청이 있습니다.');
      throw e;
    });
    return reply.status(201).send(serializeHandover(h, conv, post, user.id));
  });

  app.post('/handovers/:id/verify', { preHandler: requireAuth }, async (req) => {
    const { id } = idParam.parse(req.params);
    const user = me(req);
    const body = z.object({ note: z.string().trim().max(300).optional() }).parse(req.body ?? {});
    const { h, conv, post } = await load(id, user.id, { write: true });
    // 소유 확인은 습득자가 한다
    if (rolesOf(conv, post).finderId !== user.id) throw forbidden('습득자만 소유 확인을 할 수 있습니다.');
    if (h.status !== 'REQUESTED') throw conflict('INVALID_TRANSITION', '소유 확인을 할 수 없는 상태입니다.');
    // 대화 → 인수 → 글 순으로 잠그고, 잠긴 상태에서 인수 상태와 글 상태를 다시 읽어 검사한다(TOCTOU 제거)
    const u = await retryOnConflict(() => db.transaction(async (tx) => {
      await lockConversation(tx, h.conversationId);
      const [cur] = await tx.select().from(schema.handoverRequests).where(eq(schema.handoverRequests.id, id)).for('update');
      if (!cur || cur.status !== 'REQUESTED') throw conflict('INVALID_TRANSITION', '소유 확인을 할 수 없는 상태입니다.');
      assertPostActive((await lockPost(tx, cur.postId)).status);
      const [row] = await tx
        .update(schema.handoverRequests)
        .set({ status: 'VERIFIED', verificationNote: body.note ?? null })
        .where(eq(schema.handoverRequests.id, id))
        .returning();
      await systemMessage(tx, h.conversationId, user.id, '소유 확인이 완료되었습니다.');
      return row!;
    }));
    return serializeHandover(u, conv, post, user.id);
  });

  app.post('/handovers/:id/reject', { preHandler: requireAuth }, async (req) => {
    const { id } = idParam.parse(req.params);
    const user = me(req);
    const { h, conv, post } = await load(id, user.id, { write: true });
    if (rolesOf(conv, post).finderId !== user.id) throw forbidden('습득자만 거절할 수 있습니다.');
    if (h.status === 'COMPLETED' || h.status === 'REJECTED') throw conflict('INVALID_TRANSITION', '이미 종료된 인수 요청입니다.');
    const u = await retryOnConflict(() => db.transaction(async (tx) => {
      await lockConversation(tx, h.conversationId); // 잠금 순서 통일(대화 → 인수)
      const [row] = await tx
        .update(schema.handoverRequests)
        .set({ status: 'REJECTED' })
        .where(and(eq(schema.handoverRequests.id, id), inArray(schema.handoverRequests.status, ['REQUESTED', 'VERIFIED'])))
        .returning();
      if (row) await systemMessage(tx, h.conversationId, user.id, '인수 요청이 거절되었습니다.');
      return row;
    }));
    if (!u) throw conflict('INVALID_TRANSITION', '이미 종료된 인수 요청입니다.');
    return serializeHandover(u, conv, post, user.id);
  });

  app.post('/handovers/:id/complete', { preHandler: requireAuth }, async (req) => {
    const { id } = idParam.parse(req.params);
    const user = me(req);
    const { conv } = await load(id, user.id, { write: true });
    // 행 잠금으로 동시 완료(양쪽 클릭·더블클릭)를 직렬화한다. COMPLETED 로 바꾸는 트랜잭션만 완료 메시지를 만든다.
    const out = await retryOnConflict(() => db.transaction(async (tx) => {
      await lockConversation(tx, conv.id); // 잠금 순서: 대화 → 인수 → 글
      const [h] = await tx.select().from(schema.handoverRequests).where(eq(schema.handoverRequests.id, id)).for('update');
      if (!h) throw notFound('인수 요청을 찾을 수 없습니다.');
      if (h.status === 'COMPLETED') return { kind: 'DONE' as const, h }; // 멱등
      if (h.status === 'REQUESTED') throw conflict('NOT_VERIFIED', '소유 확인이 끝난 뒤에 인수를 완료할 수 있습니다.');
      if (h.status !== 'VERIFIED') throw conflict('INVALID_TRANSITION', '인수를 완료할 수 없는 상태입니다.');
      const post = await lockPost(tx, h.postId);
      if (!ACTIVE_POST.includes(post.status)) {
        // 글이 이미 종료됨: 영원히 완료할 수 없는 VERIFIED 로 남기지 않고 취소한다
        await tx.update(schema.handoverRequests).set({ status: 'REJECTED' }).where(eq(schema.handoverRequests.id, id));
        await systemMessage(tx, h.conversationId, user.id, '글이 종료되어 인수 요청이 취소되었습니다.');
        return { kind: 'CANCELLED' as const, h };
      }
      const finderSide = rolesOf(conv, post).finderId === user.id;
      if (finderSide ? h.foundSideConfirmedAt : h.lostSideConfirmedAt) return { kind: 'ALREADY' as const, h }; // 같은 쪽 재확인은 멱등
      const now = new Date();
      const [u] = await tx
        .update(schema.handoverRequests)
        .set(finderSide ? { foundSideConfirmedAt: now } : { lostSideConfirmedAt: now })
        .where(eq(schema.handoverRequests.id, id))
        .returning();
      if (u!.lostSideConfirmedAt && u!.foundSideConfirmedAt) {
        // 상대 글(짝) 결정: 요청 시 지정한 matchId 우선, 없으면 대화 상대의 글과의 매칭에서 추론, 못 찾으면 이 글만 닫는다(폴백)
        let pairMatchId: number | null = h.matchId;
        const postIds = [h.postId];
        if (pairMatchId !== null) {
          const [m] = await tx.select().from(schema.matches).where(eq(schema.matches.id, pairMatchId)).limit(1);
          if (m) postIds.push(m.lostPostId, m.foundPostId);
          else pairMatchId = null;
        } else {
          const otherUserId = conv.userAId === post.authorId ? conv.userBId : conv.userAId; // 글 작성자의 대화 상대
          const inferred = await inferCounterpart(tx, post, otherUserId);
          if (inferred) {
            pairMatchId = inferred.matchId;
            postIds.push(inferred.counterpartPostId);
          }
        }
        const [done] = await tx
          .update(schema.handoverRequests)
          .set({ status: 'COMPLETED', matchId: pairMatchId }) // 추론한 매칭도 기록 → 응답의 matchId/counterpartLinked
          .where(eq(schema.handoverRequests.id, id))
          .returning();
        await closeMatchesOnReturn(tx, [...new Set(postIds)], pairMatchId);
        await tx
          .update(schema.posts)
          .set({ status: 'RETURNED', closedAt: now, updatedAt: now })
          .where(and(inArray(schema.posts.id, [...new Set(postIds)]), inArray(schema.posts.status, ACTIVE_POST)));
        // 보존 시계는 최초 1회만 시작한다(재기록으로 삭제 시점이 밀리지 않게). 대화를 읽기 전용으로 만들지 않는다.
        await tx
          .update(schema.conversations)
          .set({ closedAt: now })
          .where(and(eq(schema.conversations.id, h.conversationId), isNull(schema.conversations.closedAt)));
        await systemMessage(tx, h.conversationId, user.id, '인수가 완료되었습니다.');
        return { kind: 'DONE' as const, h: done! };
      }
      await systemMessage(tx, h.conversationId, user.id, '인수 완료를 확인했습니다. 상대방의 확인을 기다립니다.');
      return { kind: 'PENDING' as const, h: u! };
    }));
    if (out.kind === 'CANCELLED') throw conflict('POST_CLOSED', '글이 이미 종료되어 인수를 완료할 수 없습니다. 인수 요청은 취소되었습니다.');
    const [post] = await db.select().from(schema.posts).where(eq(schema.posts.id, out.h.postId)).limit(1);
    return serializeHandover(out.h, conv, post!, user.id);
  });
}
