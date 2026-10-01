import 'dotenv/config';
import { z } from 'zod';

const DEV_DATABASE_URL = 'postgres://kunnect:kunnect@localhost:5432/kunnect';
const DEV_ALLOWED_ORIGINS = 'http://localhost:3000';

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    // 운영에서는 기본값을 쓰지 않는다(아래 superRefine): 설정 누락 시 개발용 DB/Origin 으로 조용히 기동하는 것을 막는다
    DATABASE_URL: z.string().min(1).optional(),
    ALLOWED_ORIGINS: z.string().optional(),
    STORAGE_DIR: z.string().default('./storage'),
    ANTHROPIC_API_KEY: z.string().optional(),
    /**
     * 사진이 한쪽이라도 없는 매칭(위치+태그만 사용)에서 AUTO(알림)를 허용할지. [사용자 결정] 별도 정책 없음 → 기본 true:
     * 사진 없는 글도 엔진의 사진 없음 임계값(0.85)으로 일반 AUTO 규칙을 따른다.
     * false 로 두면 해당 매칭을 CANDIDATE 로 낮춰 알림을 보내지 않는다(오탐 완화용 스위치).
     */
    NOPHOTO_AUTO_NOTIFY: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    /**
     * 신뢰할 프록시 홉 수. 기본 0(X-Forwarded-For 무시). Next.js rewrites 같은 프록시 뒤에서만 1 로 설정한다.
     * API 를 직접 노출하면서 1 이상으로 두면 클라이언트가 IP 를 위조해 레이트 리밋·로그인 잠금을 피할 수 있다.
     */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
    /** 보존 기간(일). README 확정: 글 종료 후 90일, 쪽지 종료 후 30일. 데모/테스트에서 줄일 수 있다(운영은 1 이상). */
    RETENTION_POST_DAYS: z.coerce.number().min(0).default(90),
    RETENTION_DM_DAYS: z.coerce.number().min(0).default(30),
    /** 종료된 글(CLOSED/RETURNED)을 종료 24시간 뒤 삭제하는 작업의 실행 주기(분). 24시간 정밀도를 위해 6시간 작업과 별도로 자주 돈다 [사용자 결정 A17] */
    CLEANUP_ENDED_POSTS_INTERVAL_MIN: z.coerce.number().int().min(1).max(1440).default(30),
  })
  .superRefine((v, ctx) => {
    if (v.NODE_ENV !== 'production') return;
    const need = (key: string, ok: boolean, message: string) => {
      if (!ok) ctx.addIssue({ code: 'custom', path: [key], message });
    };
    need('DATABASE_URL', !!v.DATABASE_URL, '운영(NODE_ENV=production)에서는 DATABASE_URL 이 필수입니다.');
    need('DATABASE_URL', v.DATABASE_URL !== DEV_DATABASE_URL, '운영에서 개발용 DATABASE_URL(kunnect:kunnect@localhost)을 쓸 수 없습니다.');
    need('ALLOWED_ORIGINS', !!v.ALLOWED_ORIGINS, '운영에서는 ALLOWED_ORIGINS 가 필수입니다(프런트 주소).');
    need('ALLOWED_ORIGINS', v.ALLOWED_ORIGINS !== DEV_ALLOWED_ORIGINS, '운영에서 ALLOWED_ORIGINS 를 개발용 기본값(localhost)으로 둘 수 없습니다.');
    need('RETENTION_POST_DAYS', v.RETENTION_POST_DAYS >= 1, '운영에서 RETENTION_POST_DAYS 는 1 이상이어야 합니다(0 이면 종료된 글이 즉시 삭제됩니다).');
    need('RETENTION_DM_DAYS', v.RETENTION_DM_DAYS >= 1, '운영에서 RETENTION_DM_DAYS 는 1 이상이어야 합니다.');
  })
  .transform((v) => ({
    ...v,
    DATABASE_URL: v.DATABASE_URL ?? DEV_DATABASE_URL,
    ALLOWED_ORIGINS: v.ALLOWED_ORIGINS ?? DEV_ALLOWED_ORIGINS,
  }));

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return schema.parse(env);
}
