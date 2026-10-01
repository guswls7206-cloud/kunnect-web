import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { schema } from '../../db/client.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { isBlockedEither } from '../../lib/blocks.js';
import { maskContacts } from '../../lib/contact-mask.js';
import { notify } from '../../lib/notify.js';
import { decodeCursor, idParam, pageQuery, toPage } from '../../lib/pagination.js';
import { me, requireAuth } from '../auth/plugin.js';

// 길이·빈도는 임시값(README 16절 #14, 사용자 정책 제공 예정): 300자, 분당 5건
const COMMENT_MAX = 300;
const MAX_REPLIES_PER_COMMENT = 100;
const bodyField = z.string().trim().min(1, '댓글을 입력해 주세요.').max(COMMENT_MAX, `댓글은 ${COMMENT_MAX}자 이하여야 합니다.`);

type CommentRow = typeof schema.comments.$inferSelect;

interface CommentOut {
  id: number;
  postId: number;
  parentId: number | null;
  author: { id: number; nickname: string };
  body: string | null;
  status: 'VISIBLE' | 'DELETED';
  createdAt: Date;
  editedAt: Date | null;
  isMine: boolean;
  replies: CommentOut[];
}

function serialize(c: CommentRow, nickname: string, viewerId: number, replies: CommentOut[] = []): CommentOut {
  const deleted = c.status === 'DELETED';
  return {
    id: c.id,
    postId: c.postId,
    parentId: c.parentId,
    author: { id: c.authorId, nickname },
    body: deleted ? null : c.body,
    status: deleted ? 'DELETED' : 'VISIBLE',
    createdAt: c.createdAt,
    editedAt: c.editedAt,
    isMine: c.authorId === viewerId,
    replies,
  };
}

export async function commentRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  app.get('/posts/:id/comments', { preHandler: requireAuth }, async (req) => {
    const { id } = idParam.parse(req.params);
    const q = pageQuery.parse(req.query);
    const viewer = me(req).id;
    const [post] = await db.select({ id: schema.posts.id, authorId: schema.posts.authorId }).from(schema.posts).where(eq(schema.posts.id, id)).limit(1);
    if (!post) throw notFound('글을 찾을 수 없습니다.');
    // [사용자 결정] 차단 관계인 작성자의 글(과 그 댓글)은 볼 수 없다
    if (post.authorId !== viewer && (await isBlockedEither(db, viewer, post.authorId))) throw notFound('글을 찾을 수 없습니다.');
    const cursor = decodeCursor(q.cursor);
    // 최상위 댓글은 오래된 순. 삭제된 최상위 댓글은 살아 있는 답글이 있을 때만 자리 유지
    const tops = await db
      .select()
      .from(schema.comments)
      .where(
        and(
          eq(schema.comments.postId, id),
          sql`${schema.comments.parentId} is null`,
          // 숨김은 제외, 삭제된 최상위 댓글은 살아 있는 답글이 있을 때만 포함 → limit 이 노출될 댓글 수 기준이 된다
          sql`(${schema.comments.status} = 'VISIBLE' or (${schema.comments.status} = 'DELETED' and exists (select 1 from comments r where r.parent_id = ${schema.comments.id} and r.status = 'VISIBLE')))`,
          cursor ? gt(schema.comments.id, cursor) : undefined,
        ),
      )
      .orderBy(asc(schema.comments.id))
      .limit(q.limit + 1);
    const page = toPage(tops, q.limit);
    const topIds = page.items.map((t) => t.id);
    const replyRows = topIds.length
      ? await db
          .select()
          .from(schema.comments)
          .where(and(inArray(schema.comments.parentId, topIds), eq(schema.comments.status, 'VISIBLE')))
          .orderBy(asc(schema.comments.id))
      : [];
    const authorIds = [...new Set([...page.items, ...replyRows].map((c) => c.authorId))];
    const authors = authorIds.length ? await db.select({ id: schema.users.id, nickname: schema.users.nickname }).from(schema.users).where(inArray(schema.users.id, authorIds)) : [];
    const nick = new Map(authors.map((a) => [a.id, a.nickname]));
    const items = page.items
      .map((t) => {
        // 부모당 답글은 최대 100개까지만 내려준다(응답 크기 상한)
        const replies = replyRows.filter((r) => r.parentId === t.id).slice(0, MAX_REPLIES_PER_COMMENT).map((r) => serialize(r, nick.get(r.authorId) ?? '', viewer));
        return { t, replies };
      })
      .filter(({ t, replies }) => t.status === 'VISIBLE' || replies.length > 0)
      .map(({ t, replies }) => serialize(t, nick.get(t.authorId) ?? '', viewer, replies));
    return { items, nextCursor: page.nextCursor };
  });

  app.post('/posts/:id/comments', { preHandler: requireAuth, config: ctx.rl(5, 60_000) }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const user = me(req);
    const body = z.object({ body: bodyField, parentId: z.number().int().positive().optional() }).parse(req.body);
    const [post] = await db.select().from(schema.posts).where(eq(schema.posts.id, id)).limit(1);
    if (!post) throw notFound('글을 찾을 수 없습니다.');
    if (post.authorId !== user.id && (await isBlockedEither(db, user.id, post.authorId))) throw notFound('글을 찾을 수 없습니다.');
    if (post.status === 'RETURNED' || post.status === 'CLOSED') throw conflict('POST_CLOSED', '종료된 글에는 댓글을 달 수 없습니다.');
    let parent: CommentRow | undefined;
    if (body.parentId) {
      [parent] = await db.select().from(schema.comments).where(eq(schema.comments.id, body.parentId)).limit(1);
      // 대댓글은 1단계만, 같은 글의 최상위 댓글에만 가능
      if (!parent || parent.postId !== id || parent.parentId !== null) throw badRequest('PARENT_INVALID', '답글을 달 수 없는 댓글입니다.');
      if (parent.status !== 'VISIBLE') throw badRequest('PARENT_INVALID', '삭제된 댓글에는 답글을 달 수 없습니다.');
    }
    const masked = maskContacts(body.body);
    const [c] = await db
      .insert(schema.comments)
      .values({ postId: id, authorId: user.id, parentId: parent?.id ?? null, body: masked.text })
      .returning();
    // 알림: 답글은 원 댓글 작성자에게, 최상위 댓글은 글 작성자에게. 본인 제외
    if (parent) {
      if (parent.authorId !== user.id) await notify(db, { userId: parent.authorId, actorId: user.id, type: 'REPLY', postId: id, commentId: c!.id });
    } else if (post.authorId !== user.id) {
      await notify(db, { userId: post.authorId, actorId: user.id, type: 'COMMENT', postId: id, commentId: c!.id });
    }
    return reply.status(201).send({ comment: serialize(c!, user.nickname, user.id), masked: masked.masked });
  });

  app.patch('/comments/:id', { preHandler: requireAuth, config: ctx.rl(20, 60_000) }, async (req) => {
    const { id } = idParam.parse(req.params);
    const user = me(req);
    const body = z.object({ body: bodyField }).parse(req.body);
    const [c] = await db.select().from(schema.comments).where(eq(schema.comments.id, id)).limit(1);
    if (!c) throw notFound('댓글을 찾을 수 없습니다.');
    if (c.authorId !== user.id) throw forbidden('내 댓글만 수정할 수 있습니다.');
    if (c.status !== 'VISIBLE') throw conflict('COMMENT_DELETED', '삭제된 댓글은 수정할 수 없습니다.');
    const masked = maskContacts(body.body);
    const [u] = await db.update(schema.comments).set({ body: masked.text, editedAt: new Date() }).where(eq(schema.comments.id, id)).returning();
    return { comment: serialize(u!, user.nickname, user.id), masked: masked.masked };
  });

  app.delete('/comments/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const user = me(req);
    const [c] = await db.select().from(schema.comments).where(eq(schema.comments.id, id)).limit(1);
    if (!c) throw notFound('댓글을 찾을 수 없습니다.');
    if (c.authorId !== user.id) throw forbidden('내 댓글만 삭제할 수 있습니다.');
    const replies = await db.select({ id: schema.comments.id }).from(schema.comments).where(and(eq(schema.comments.parentId, id), eq(schema.comments.status, 'VISIBLE'))).limit(1);
    if (replies.length) {
      // 답글이 있으면 자리를 유지하고 본문은 비운다
      await db.update(schema.comments).set({ status: 'DELETED', body: '' }).where(eq(schema.comments.id, id));
    } else {
      await db.delete(schema.comments).where(eq(schema.comments.id, id));
    }
    return reply.status(204).send();
  });

  app.get('/me/comments', { preHandler: requireAuth }, async (req) => {
    const q = pageQuery.parse(req.query);
    const user = me(req);
    const cursor = decodeCursor(q.cursor);
    const rows = await db
      .select({ c: schema.comments, postTitle: schema.posts.title })
      .from(schema.comments)
      .innerJoin(schema.posts, eq(schema.posts.id, schema.comments.postId))
      .where(and(eq(schema.comments.authorId, user.id), eq(schema.comments.status, 'VISIBLE'), cursor ? sql`${schema.comments.id} < ${cursor}` : undefined))
      .orderBy(desc(schema.comments.id))
      .limit(q.limit + 1);
    const page = toPage(rows.map((r) => ({ ...r, id: r.c.id })), q.limit);
    return {
      items: page.items.map((r) => ({ ...serialize(r.c, user.nickname, user.id), postTitle: r.postTitle })),
      nextCursor: page.nextCursor,
    };
  });
}
