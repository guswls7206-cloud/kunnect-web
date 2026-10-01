import argon2 from 'argon2';
import { and, count, desc, eq, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { schema } from '../../db/client.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { isBlockedEither, notBlockedWith, notificationVisible } from '../../lib/blocks.js';
import { isUniqueViolation, pgConstraint } from '../../lib/pg.js';
import { bumpCounter, clearCounter, readCounter } from '../../lib/db-counters.js';
import { decodeCursor, idParam, pageQuery, toPage } from '../../lib/pagination.js';
import { deleteFiles, hardDeletePosts } from '../../lib/hard-delete.js';
import { retryOnConflict } from '../handovers/service.js';
import { loadPostCards } from '../posts/service.js';
import { clearSessionCookie, createSession, me, requireAuth } from './plugin.js';

const loginIdSchema = z
  .string()
  .transform((s) => s.trim().toLowerCase())
  .pipe(z.string().regex(/^[a-z0-9_]{4,20}$/, '아이디는 4~20자의 영소문자·숫자·_ 만 사용할 수 있습니다.'))
  // 탈퇴 계정 익명화 값(deleted_<id>)과 충돌하지 않도록 예약
  .refine((v) => !v.startsWith('deleted_'), '사용할 수 없는 아이디입니다.');
const COMMON_PASSWORDS = new Set(['password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwerty123', 'qwertyuiop', 'iloveyou', 'abc12345', 'asdf1234', '11111111', '00000000', 'admin1234', 'kunnect1234']);
const passwordSchema = z
  .string()
  .min(8, '비밀번호는 8자 이상이어야 합니다.')
  .max(64, '비밀번호는 64자 이하여야 합니다.')
  .refine((p) => !COMMON_PASSWORDS.has(p.toLowerCase()) && new Set(p).size >= 4, '너무 흔하거나 단순한 비밀번호입니다.');
const nicknameSchema = z
  .string()
  .transform((s) => s.normalize('NFC').trim())
  .pipe(z.string().regex(/^[0-9A-Za-z_ㄱ-ㆎ가-힣]{2,12}$/, '닉네임은 2~12자의 한글·영문·숫자·_ 만 사용할 수 있습니다.'))
  // 탈퇴 계정 익명화 값(탈퇴한사용자<id>)과 충돌하지 않도록 예약
  .refine((v) => !v.startsWith('탈퇴한사용자'), '사용할 수 없는 닉네임입니다.');

const signupBody = z.object({ loginId: loginIdSchema, password: passwordSchema, nickname: nicknameSchema });
const loginBody = z.object({ loginId: z.string().max(40), password: z.string().max(200) });

// argon2id (OWASP 최소 권장: m=19MiB, t=2, p=1)
const ARGON_OPTS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;
let dummyHash: Promise<string> | null = null;

/**
 * 로그인 실패 제한(PostgreSQL 카운터, 재시작·다중 인스턴스에서도 유지):
 * - IP+아이디: 10분에 5회 실패 시 잠금 (일반적인 추측 공격 차단)
 * - 아이디 단독: 10분에 30회 실패 시 잠금 (IP 를 바꿔가며 하는 분산 공격 차단. 피해자 계정 잠금 남용을 어렵게 하려고 임계를 높게 둔다)
 */
const FAIL_IP_LIMIT = 5;
const FAIL_ID_LIMIT = 30;
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const ipKeyOf = (ip: string, loginId: string) => `lf:ip:${ip}|${loginId.trim().toLowerCase()}`;
const idKeyOf = (loginId: string) => `lf:id:${loginId.trim().toLowerCase()}`;
/** 최근 로그인에 성공한 적 있는 (아이디, IP) 기록 — 아이디 단독 잠금이 걸려도 본인의 평소 IP 는 막지 않는다 */
const knownKeyOf = (ip: string, loginId: string) => `lf:ok:${loginId.trim().toLowerCase()}|${ip}`;
const KNOWN_IP_WINDOW_MS = 30 * 24 * 3600 * 1000;

async function assertNotLocked(ctx: Ctx, ip: string, loginId: string, enabled: boolean) {
  if (!enabled) return;
  const [byIp, byId] = await Promise.all([readCounter(ctx.db, ipKeyOf(ip, loginId)), readCounter(ctx.db, idKeyOf(loginId))]);
  // 아이디 단독 잠금(분산 공격 대응)은 이 아이디로 최근 성공한 적 있는 IP 에는 적용하지 않는다 → 공격자가 피해자를 잠글 수 없다.
  // (그 IP 에서의 추측 공격은 IP+아이디 5회 한도가 막는다)
  const idLocked = byId >= FAIL_ID_LIMIT && (await readCounter(ctx.db, knownKeyOf(ip, loginId))) === 0;
  if (byIp >= FAIL_IP_LIMIT || idLocked) throw new AppError(429, 'RATE_LIMITED', '로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.');
}

async function recordFailure(ctx: Ctx, ip: string, loginId: string) {
  await Promise.all([bumpCounter(ctx.db, ipKeyOf(ip, loginId), FAIL_WINDOW_MS), bumpCounter(ctx.db, idKeyOf(loginId), FAIL_WINDOW_MS)]);
}

/** 폴링용 읽지 않음 요약. notifications 는 쪽지(MESSAGE) 알림을 제외하고, messages 는 쪽지함 읽지 않은 메시지 수. */
export async function unreadSummary(ctx: Ctx, userId: number) {
  const { db } = ctx;
  const [n] = await db
    .select({ c: count() })
    .from(schema.notifications)
    .where(and(eq(schema.notifications.userId, userId), isNull(schema.notifications.readAt), ne(schema.notifications.type, 'MESSAGE'), notificationVisible(userId)));
  const res = await db.execute<{ c: number }>(sql`
    select count(*)::int as c from messages m
      join conversation_members cm on cm.conversation_id = m.conversation_id and cm.user_id = ${userId}
     where m.sender_id <> ${userId} and m.deleted_at is null
       and m.id > cm.last_read_message_id and m.id > cm.cleared_message_id and cm.left_at is null
       and ${notBlockedWith(userId, sql`m.sender_id`)}`);
  return { notifications: n?.c ?? 0, messages: res.rows[0]?.c ?? 0 };
}

export async function authRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;
  const lockEnabled = ctx.config.NODE_ENV !== 'test' || process.env.TEST_LOGIN_LOCK === '1';

  const toMe = async (u: typeof schema.users.$inferSelect) => ({
    id: u.id,
    loginId: u.loginId,
    nickname: u.nickname,
    settings: { notifyMatch: u.notifyMatch, notifyComment: u.notifyComment, notifyMessage: u.notifyMessage },
    unread: await unreadSummary(ctx, u.id),
  });

  app.post('/auth/signup', { config: ctx.rl(5, 3600_000) }, async (req, reply) => {
    const body = signupBody.parse(req.body);
    if (body.password === body.loginId) {
      throw badRequest('WEAK_PASSWORD', '비밀번호는 아이디와 달라야 합니다.', { password: '아이디와 같은 비밀번호는 사용할 수 없습니다.' });
    }
    const nicknameLower = body.nickname.toLowerCase();
    const [dupLogin] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.loginId, body.loginId)).limit(1);
    if (dupLogin) throw conflict('LOGIN_ID_TAKEN', '이미 사용 중인 아이디입니다.');
    const [dupNick] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.nicknameLower, nicknameLower)).limit(1);
    if (dupNick) throw conflict('NICKNAME_TAKEN', '이미 사용 중인 닉네임입니다.');
    const passwordHash = await argon2.hash(body.password, ARGON_OPTS);
    let user;
    try {
      [user] = await db.insert(schema.users).values({ loginId: body.loginId, passwordHash, nickname: body.nickname, nicknameLower }).returning();
    } catch (e) {
      // 동시 가입 경합 시 unique 제약 위반
      // 동시 가입 경합: 위반된 제약 이름으로 아이디/닉네임을 구분한다
      if (isUniqueViolation(e)) {
        if (pgConstraint(e) === 'users_nickname_lower_uq') throw conflict('NICKNAME_TAKEN', '이미 사용 중인 닉네임입니다.');
        throw conflict('LOGIN_ID_TAKEN', '이미 사용 중인 아이디입니다.');
      }
      throw e;
    }
    if (!user) throw new Error('가입 실패');
    await createSession(ctx, reply, user.id, req.headers['user-agent'], req.sessionId);
    return reply.status(201).send({ user: await toMe(user) });
  });

  app.post('/auth/login', { config: ctx.rl(30, 600_000) }, async (req, reply) => {
    const body = loginBody.parse(req.body);
    await assertNotLocked(ctx, req.ip, body.loginId, lockEnabled);
    const [user] = await db.select().from(schema.users).where(eq(schema.users.loginId, body.loginId.trim().toLowerCase())).limit(1);
    // 존재하지 않는 아이디에도 해시 검증을 수행해 응답 시간 차이로 아이디 존재 여부가 드러나지 않게 한다
    dummyHash ??= argon2.hash('dummy-password-for-timing', ARGON_OPTS);
    const ok = await argon2.verify(user?.passwordHash ?? (await dummyHash), body.password).catch(() => false);
    if (!user || !ok || user.status !== 'ACTIVE') {
      await recordFailure(ctx, req.ip, body.loginId);
      throw new AppError(401, 'INVALID_CREDENTIALS', '아이디 또는 비밀번호가 올바르지 않습니다.');
    }
    await clearCounter(db, ipKeyOf(req.ip, body.loginId));
    if (lockEnabled) await bumpCounter(db, knownKeyOf(req.ip, body.loginId), KNOWN_IP_WINDOW_MS);
    await createSession(ctx, reply, user.id, req.headers['user-agent'], req.sessionId);
    return { user: await toMe(user) };
  });

  /** 모든 기기에서 로그아웃(내 세션 전부 폐기). */
  app.post('/auth/logout-all', { preHandler: requireAuth }, async (req, reply) => {
    await db.delete(schema.sessions).where(eq(schema.sessions.userId, me(req).id));
    clearSessionCookie(reply);
    return reply.status(204).send();
  });

  app.post('/auth/logout', { preHandler: requireAuth }, async (req, reply) => {
    if (req.sessionId) await db.delete(schema.sessions).where(eq(schema.sessions.id, req.sessionId));
    clearSessionCookie(reply);
    return reply.status(204).send();
  });

  app.get('/me', { preHandler: requireAuth }, async (req) => {
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, me(req).id)).limit(1);
    if (!u) throw new AppError(401, 'UNAUTHENTICATED', '로그인이 필요합니다.');
    return toMe(u);
  });

  app.patch('/me/settings', { preHandler: requireAuth, config: ctx.rl(30, 60_000) }, async (req) => {
    const body = z
      .object({ notifyMatch: z.boolean().optional(), notifyComment: z.boolean().optional(), notifyMessage: z.boolean().optional() })
      .parse(req.body);
    const userId = me(req).id;
    if (Object.keys(body).length) await db.update(schema.users).set(body).where(eq(schema.users.id, userId));
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    return { notifyMatch: u!.notifyMatch, notifyComment: u!.notifyComment, notifyMessage: u!.notifyMessage };
  });

  app.post('/me/password', { preHandler: requireAuth, config: ctx.rl(10, 3600_000) }, async (req, reply) => {
    const body = z.object({ currentPassword: z.string().max(200), newPassword: passwordSchema }).parse(req.body);
    const user = me(req);
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).limit(1);
    if (!u || !(await argon2.verify(u.passwordHash, body.currentPassword).catch(() => false))) {
      throw forbidden('현재 비밀번호가 올바르지 않습니다.', 'WRONG_PASSWORD');
    }
    if (body.newPassword === u.loginId) throw badRequest('WEAK_PASSWORD', '비밀번호는 아이디와 달라야 합니다.');
    if (body.newPassword === body.currentPassword) throw badRequest('WEAK_PASSWORD', '현재 비밀번호와 다른 비밀번호를 입력해 주세요.', { newPassword: '현재 비밀번호와 같습니다.' });
    const newHash = await argon2.hash(body.newPassword, ARGON_OPTS);
    // 비밀번호 교체와 다른 세션 폐기는 한 트랜잭션(중간 상태 방지)
    await db.transaction(async (tx) => {
      await tx.update(schema.users).set({ passwordHash: newHash }).where(eq(schema.users.id, user.id));
      if (req.sessionId) await tx.delete(schema.sessions).where(and(eq(schema.sessions.userId, user.id), ne(schema.sessions.id, req.sessionId)));
    });
    return reply.status(204).send();
  });

  /**
   * 계정 삭제(탈퇴). 개인정보 처리 방침(README 10절):
   * - 계정 식별 정보(아이디·비밀번호 해시·닉네임)는 즉시 제거(익명 닉네임으로 치환)하고 세션·알림·차단·글에 연결되지 않은 임시 사진을 삭제한다(Web Push 구독은 아직 미구현).
   * - [사용자 결정] 작성한 글(진행 중·종료·반환 완료 모두)과 댓글은 즉시 영구 삭제한다(사진 원본·AI 사본·흐림 사본 파일, 매칭·알림 등 연관 데이터 포함).
   * - 쪽지 대화는 그대로 두고 상대는 읽기만 가능하다(보존은 "마지막 메시지 후 30일" 규칙). 신고 기록(snapshot)은 보존한다.
   */
  app.delete('/me', { preHandler: requireAuth, config: ctx.rl(5, 3600_000) }, async (req, reply) => {
    const { password } = z.object({ password: z.string().max(200) }).parse(req.body);
    const user = me(req);
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).limit(1);
    if (!u || !(await argon2.verify(u.passwordHash, password).catch(() => false))) throw forbidden('비밀번호가 올바르지 않습니다.', 'WRONG_PASSWORD');
    // 임시(글에 연결 안 된) 사진 파일 키는 트랜잭션 전에 수집, 글 사진 파일 키는 hardDeletePosts 가 돌려준다 → 커밋 후 파일 삭제
    const pendingPhotos = await db
      .select({ key: schema.postPhotos.storageKey, aiKey: schema.postPhotos.aiKey, blurredKey: schema.postPhotos.blurredKey })
      .from(schema.postPhotos)
      .where(and(eq(schema.postPhotos.ownerId, user.id), isNull(schema.postPhotos.postId)));
    // 잠금 순서를 인수 처리와 동일하게 맞춘다: 대화 -> 인수 요청 -> 글 (교착 방지). 그래도 충돌하면(40P01/40001) 통째로 재시도
    const deleted = await retryOnConflict(() =>
      db.transaction(async (tx) => {
        // 대화 행을 먼저 잠가(handover 전이와 같은 순서) 진행 중인 인수 요청 처리와 경합하지 않게 한다
        await tx.execute(sql`select id from conversations where user_a_id = ${user.id} or user_b_id = ${user.id} order by id for update`);
        // 진행 중인 인수 요청은 거절 처리(탈퇴를 막지 않는다). 대화·쪽지는 새 보존 규칙(마지막 메시지 후 30일)을 따르므로 여기서 건드리지 않는다
        await tx
          .update(schema.handoverRequests)
          .set({ status: 'REJECTED' })
          .where(
            and(
              inArray(schema.handoverRequests.status, ['REQUESTED', 'VERIFIED']),
              sql`${schema.handoverRequests.conversationId} in (select id from conversations where user_a_id = ${user.id} or user_b_id = ${user.id})`,
            ),
          );
        // [사용자 결정] 탈퇴 시 작성한 글과 댓글을 즉시 영구 삭제(진행 중·종료·반환 완료 모두). 매칭·알림·사진 파일 등 연관 데이터 포함
        const myPosts = await tx.select({ id: schema.posts.id }).from(schema.posts).where(eq(schema.posts.authorId, user.id));
        const removed = await hardDeletePosts(tx, myPosts.map((p) => p.id));
        // 내 댓글과, 내 댓글에 달린 답글(부모 FK 가 없어 직접 지운다)을 모두 삭제
        await tx.execute(sql`
          delete from comments where author_id = ${user.id}
             or parent_id in (select id from comments where author_id = ${user.id})`);
        await tx.delete(schema.postPhotos).where(and(eq(schema.postPhotos.ownerId, user.id), isNull(schema.postPhotos.postId)));
        await tx.delete(schema.notifications).where(eq(schema.notifications.userId, user.id));
        await tx.delete(schema.blocks).where(sql`${schema.blocks.blockerId} = ${user.id} or ${schema.blocks.blockedId} = ${user.id}`);
        await tx.delete(schema.sessions).where(eq(schema.sessions.userId, user.id));
        await tx
          .update(schema.users)
          .set({
            status: 'DELETED',
            loginId: `deleted_${user.id}`,
            nickname: `탈퇴한사용자${user.id}`,
            nicknameLower: `탈퇴한사용자${user.id}`,
            passwordHash: '!deleted', // 어떤 비밀번호와도 일치하지 않는 값
          })
          .where(eq(schema.users.id, user.id));
        return removed;
      }),
    );
    // 파일은 커밋 후 삭제(실패해도 정리 작업의 고아 파일 정리가 회수)
    await deleteFiles(ctx.storage, [...deleted.fileKeys, ...pendingPhotos.flatMap((p) => [p.key, p.aiKey, p.blurredKey].filter((k): k is string => !!k))]);
    clearSessionCookie(reply);
    return reply.status(204).send();
  });

  app.get('/users/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = idParam.parse(req.params);
    const [u] = await db.select().from(schema.users).where(and(eq(schema.users.id, id), eq(schema.users.status, 'ACTIVE'))).limit(1);
    if (!u) throw notFound('사용자를 찾을 수 없습니다.');
    // [사용자 결정] 차단 시 프로필 비노출(양방향, 차단 사실은 드러내지 않고 404)
    if (u.id !== me(req).id && (await isBlockedEither(db, me(req).id, u.id))) throw notFound('사용자를 찾을 수 없습니다.');
    const [pc] = await db
      .select({ c: count() })
      .from(schema.posts)
      .where(and(eq(schema.posts.authorId, id), inArray(schema.posts.status, ['OPEN', 'MATCHED'])));
    const [blocked] = await db
      .select({ x: schema.blocks.blockerId })
      .from(schema.blocks)
      .where(and(eq(schema.blocks.blockerId, me(req).id), eq(schema.blocks.blockedId, id)))
      .limit(1);
    return { id: u.id, nickname: u.nickname, createdAt: u.createdAt, postCount: pc?.c ?? 0, isBlockedByMe: !!blocked };
  });

  app.get('/users/:id/posts', { preHandler: requireAuth }, async (req) => {
    const { id } = idParam.parse(req.params);
    const q = pageQuery.parse(req.query);
    const cursor = decodeCursor(q.cursor);
    if (id !== me(req).id && (await isBlockedEither(db, me(req).id, id))) throw notFound('사용자를 찾을 수 없습니다.');
    const rows = await db
      .select({ id: schema.posts.id })
      .from(schema.posts)
      .where(and(eq(schema.posts.authorId, id), inArray(schema.posts.status, ['OPEN', 'MATCHED']), cursor ? lt(schema.posts.id, cursor) : undefined))
      .orderBy(desc(schema.posts.id))
      .limit(q.limit + 1);
    const page = toPage(rows, q.limit);
    return { items: await loadPostCards(db, page.items.map((r) => r.id), me(req).id), nextCursor: page.nextCursor };
  });
}
