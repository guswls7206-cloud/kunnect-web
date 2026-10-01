import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import { createDbRateStore, isDrizzleQueryError, safeErrorMessage } from './lib/db-counters.js';
import { AppError } from './lib/errors.js';
import { pgCode } from './lib/pg.js';
import { LocalDiskStorage, type PhotoStorage } from './storage/index.js';
import { registerDocs } from './docs.js';
import { registerAuth } from './modules/auth/plugin.js';
import { authRoutes } from './modules/auth/routes.js';
import { catalogRoutes } from './modules/catalog/routes.js';
import { fileRoutes } from './modules/files/routes.js';
import { photoRoutes } from './modules/photos/routes.js';
import { postRoutes } from './modules/posts/routes.js';
import { commentRoutes } from './modules/comments/routes.js';
import { notificationRoutes } from './modules/notifications/routes.js';
import { matchRoutes } from './modules/matches/routes.js';
import { conversationRoutes } from './modules/conversations/routes.js';
import { handoverRoutes } from './modules/handovers/routes.js';
import { safetyRoutes } from './modules/safety/routes.js';

export interface Ctx {
  db: Db;
  config: Config;
  storage: PhotoStorage;
  /** 레이트 리밋 활성 여부(테스트에서는 기본 비활성) */
  rateLimitEnabled: boolean;
  /** 라우트별 레이트 리밋 설정. 비활성화되면 사실상 무제한 값을 돌려준다. */
  rl: (max: number, windowMs: number) => { rateLimit: { max: number; timeWindow: number } };
}

export interface BuildOptions {
  config: Config;
  db: Db;
  storage?: PhotoStorage;
  rateLimitEnabled?: boolean;
}

export async function buildApp(opts: BuildOptions): Promise<FastifyInstance> {
  const { config, db } = opts;
  const storage = opts.storage ?? new LocalDiskStorage(config.STORAGE_DIR);
  const app = Fastify({
    logger:
      config.NODE_ENV === 'test' && !process.env.TEST_LOG
        ? false
        : {
            redact: ['req.headers.cookie', 'req.headers.authorization'],
            // 요청 로그에서 쿼리 문자열을 제거한다(검색어·커서 등 사용자 입력이 로그에 남지 않게)
            serializers: {
              req: (req: { method?: string; url?: string; host?: string; ip?: string }) => ({ method: req.method, url: req.url?.split('?')[0], host: req.host, remoteAddress: req.ip }),
            },
          },
    bodyLimit: 100 * 1024, // JSON 100KB (업로드는 multipart 별도 제한)
    trustProxy: config.TRUST_PROXY_HOPS > 0 ? (_addr: string, hop: number) => hop < config.TRUST_PROXY_HOPS : false,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-site' } });
  await app.register(cookie);
  const rateLimitEnabled = opts.rateLimitEnabled ?? config.NODE_ENV !== 'test';
  await app.register(rateLimit, {
    global: false,
    hook: 'preHandler',
    keyGenerator: (req) => (req.user ? `u${req.user.id}` : req.ip),
    // 활성화 시 PostgreSQL 저장소(재시작·다중 인스턴스에서도 유지). 비활성(테스트 기본)이면 메모리 저장소
    ...(rateLimitEnabled ? { store: createDbRateStore(db) as never } : {}),
  });
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 5 } });
  const enabled = rateLimitEnabled;
  const ctx: Ctx = {
    db,
    config,
    storage,
    rateLimitEnabled: enabled,
    rl: (max, timeWindow) => ({ rateLimit: enabled ? { max, timeWindow } : { max: 1_000_000, timeWindow: 1000 } }),
  };

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, ...(err.fields ? { fields: err.fields } : {}) } });
    }
    const validation = toValidationFields(err);
    if (validation) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: '입력값이 올바르지 않습니다.', fields: validation } });
    }
    // 동시 변경 경합의 최후 방어선: 교착(40P01)·직렬화 실패(40001)가 재시도로 해소되지 않으면 500 대신 409 로 안내한다
    if (pgCode(err) === '40P01' || pgCode(err) === '40001') {
      return reply.status(409).send({ error: { code: 'CONFLICT', message: '동시에 처리되어 실패했습니다. 잠시 후 다시 시도해 주세요.' } });
    }
    // 동시 삭제 경합: 대상 글/사용자가 요청 처리 중에 영구 삭제되어 FK 위반(23503)이 나면 500 이 아니라 404 로 응답한다
    if (pgCode(err) === '23503') {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: '대상이 이미 삭제되었습니다.' } });
    }
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e.statusCode === 429) {
      return reply.status(429).send({ error: { code: 'RATE_LIMITED', message: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' } });
    }
    if (e.code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.status(413).send({ error: { code: 'FILE_TOO_LARGE', message: '파일은 10MB 이하여야 합니다.' } });
    }
    if (e.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.status(413).send({ error: { code: 'PAYLOAD_TOO_LARGE', message: '요청이 너무 큽니다.' } });
    }
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: { code: e.statusCode === 415 ? 'UNSUPPORTED_TYPE' : 'BAD_REQUEST', message: '잘못된 요청입니다.' } });
    }
    // err 객체를 그대로 기록하지 않는다(Drizzle 오류에는 쿼리 파라미터=개인정보·해시가 포함됨)
    app.log.error({ errName: (err as Error).name, errMessage: safeErrorMessage(err), stack: isDrizzleQueryError(err as Error) ? undefined : (err as Error).stack?.split('\n').slice(0, 6).join('\n') }, '요청 처리 중 서버 오류');
    return reply.status(500).send({ error: { code: 'INTERNAL', message: '서버 오류가 발생했습니다.' } });
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: 'NOT_FOUND', message: '존재하지 않는 경로입니다.' } }));

  if (config.NODE_ENV !== 'production') await registerDocs(app);
  await registerAuth(app, ctx);

  await app.register(
    async (api) => {
      api.get('/health', async () => ({ status: 'ok' }));
      await authRoutes(api, ctx);
      await catalogRoutes(api, ctx);
      await photoRoutes(api, ctx);
      await fileRoutes(api, ctx);
      await postRoutes(api, ctx);
      await commentRoutes(api, ctx);
      await notificationRoutes(api, ctx);
      await matchRoutes(api, ctx);
      await conversationRoutes(api, ctx);
      await handoverRoutes(api, ctx);
      await safetyRoutes(api, ctx);
    },
    { prefix: '/api/v1' },
  );

  return app;
}

function toValidationFields(err: unknown): Record<string, string> | null {
  const isZod = err instanceof ZodError;
  const maybe = err as { validation?: unknown; cause?: unknown; issues?: unknown };
  const zerr = isZod ? err : maybe.cause instanceof ZodError ? maybe.cause : null;
  const issues = zerr ? zerr.issues : Array.isArray(maybe.issues) ? (maybe.issues as ZodError['issues']) : null;
  if (!issues && !maybe.validation) return null;
  const fields: Record<string, string> = {};
  for (const i of issues ?? []) fields[i.path.join('.') || '_'] = i.message;
  return fields;
}
