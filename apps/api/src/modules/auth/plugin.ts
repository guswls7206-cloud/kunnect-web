import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Ctx } from '../../app.js';
import { schema } from '../../db/client.js';
import { AppError, forbidden } from '../../lib/errors.js';

export const SESSION_COOKIE = 'kunnect_sid';
const SESSION_DAYS = 14;
const DAY_MS = 24 * 3600 * 1000;

export interface AuthUser {
  id: number;
  loginId: string;
  nickname: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
    sessionId: string | null;
  }
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** 세션 쿠키 옵션(발급·연장에서 공통 사용) */
function sessionCookieOptions(ctx: Ctx, expires: Date) {
  return { httpOnly: true, sameSite: 'lax' as const, secure: ctx.config.NODE_ENV === 'production', path: '/', expires };
}

/** [가정/제안] 사용자당 동시 세션 상한. 초과하면 가장 오래된 세션부터 폐기한다. */
export const MAX_SESSIONS_PER_USER = 5;

/**
 * 새 세션 발급. 요청이 제시한 기존 세션 토큰(previousSessionId)이 있으면 폐기한다(세션 고정 방지: 로그인/가입 때 항상 새 토큰으로 교체).
 */
export async function createSession(ctx: Ctx, reply: FastifyReply, userId: number, userAgent?: string, previousSessionId?: string | null) {
  if (previousSessionId) await ctx.db.delete(schema.sessions).where(eq(schema.sessions.id, previousSessionId));
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * DAY_MS);
  await ctx.db.insert(schema.sessions).values({ id: hashToken(token), userId, expiresAt, userAgent: userAgent?.slice(0, 200) });
  // 동시 세션 상한: 최신 N 개만 유지
  await ctx.db.execute(sql`
    delete from sessions where user_id = ${userId} and id not in (
      select id from sessions where user_id = ${userId} order by created_at desc, id desc limit ${MAX_SESSIONS_PER_USER})`);
  reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions(ctx, expiresAt));
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export async function registerAuth(app: FastifyInstance, ctx: Ctx) {
  const allowed = new Set(ctx.config.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean));
  app.decorateRequest('user', null);
  app.decorateRequest('sessionId', null);

  // CSRF 완화: 브라우저가 보낸 Origin 이 있고 허용 목록/자기 자신이 아니면 상태 변경 요청 거부
  app.addHook('onRequest', async (req) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    // Origin 이 없어도 브라우저가 cross-site 로 표시한 요청은 거부(Sec-Fetch-Site 지원 브라우저)
    if (req.headers['sec-fetch-site'] === 'cross-site' && !req.headers.origin) throw forbidden('허용되지 않은 출처의 요청입니다.', 'BAD_ORIGIN');
    const origin = req.headers.origin;
    if (!origin) {
      // 세션 쿠키를 가진 상태 변경 요청은 Origin 이 있어야 한다. 브라우저는 POST/PATCH/DELETE 에 항상 Origin 을 붙이므로
      // 정상 사용에 영향이 없고, Origin 을 숨기는 CSRF 를 막는다. 쿠키 없는 요청(가입·로그인)과 비브라우저 도구는 헤더를 직접 지정하면 된다.
      if (req.cookies[SESSION_COOKIE]) throw forbidden('Origin 헤더가 필요합니다.', 'BAD_ORIGIN');
      return;
    }
    const self = `${req.protocol}://${req.headers.host}`;
    if (origin !== self && !allowed.has(origin)) throw forbidden('허용되지 않은 출처의 요청입니다.', 'BAD_ORIGIN');
  });

  app.addHook('onRequest', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return;
    const id = hashToken(token);
    const [row] = await ctx.db
      .select({ uid: schema.users.id, loginId: schema.users.loginId, nickname: schema.users.nickname, expiresAt: schema.sessions.expiresAt })
      .from(schema.sessions)
      .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
      .where(and(eq(schema.sessions.id, id), gt(schema.sessions.expiresAt, new Date()), eq(schema.users.status, 'ACTIVE')))
      .limit(1);
    if (row) {
      req.user = { id: row.uid, loginId: row.loginId, nickname: row.nickname };
      req.sessionId = id;
      // 슬라이딩 만료: 마지막 연장 후 하루 이상 지났으면 만료 시각과 쿠키를 14일 뒤로 연장(요청마다 쓰기를 피함)
      const full = SESSION_DAYS * DAY_MS;
      if (row.expiresAt.getTime() - Date.now() < full - DAY_MS) {
        const expiresAt = new Date(Date.now() + full);
        await ctx.db.update(schema.sessions).set({ expiresAt }).where(eq(schema.sessions.id, id));
        reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions(ctx, expiresAt));
      }
    }
  });
}

/** 로그인 필수 라우트용 preHandler */
export async function requireAuth(req: FastifyRequest) {
  if (!req.user) throw new AppError(401, 'UNAUTHENTICATED', '로그인이 필요합니다.');
}

/** 핸들러 안에서 user 를 타입 안전하게 꺼낸다. */
export function me(req: FastifyRequest): AuthUser {
  if (!req.user) throw new AppError(401, 'UNAUTHENTICATED', '로그인이 필요합니다.');
  return req.user;
}
