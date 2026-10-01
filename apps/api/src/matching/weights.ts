/**
 * 가중치·임계값·AI 설정. 모든 수치는 환경변수로 덮어쓸 수 있다(시연 점검 시 튜닝).
 * 기본값 출처: README 5.3(확정 5번), 5.4(사진 없음 0.85는 [가정/제안]), docs/dev-plan-backend.md 6.3~6.5.
 */
import type { CategorySlug } from './types.js';

/** 민감한 사진을 AI 로 보낼 때의 처리. SEND: 그대로 / BLUR: 강하게 흐려서 / SKIP: 보내지 않고 태그만 사용 */
export type SensitiveMode = 'SEND' | 'BLUR' | 'SKIP';

export interface MatchingConfig {
  /** 양쪽 사진 신호가 있을 때 */
  weights: { photo: number; location: number; tag: number };
  /** 사진 신호를 제외(재정규화)할 때 */
  noPhotoWeights: { location: number; tag: number };
  /** 자동 연결+알림 임계값(사진 있음) */
  autoThreshold: number;
  /** 자동 알림 임계값(사진 없음, 신호 2개라 상향) */
  autoThresholdNoPhoto: number;
  /** 후보 표시 임계값 */
  candidateThreshold: number;
  /** 사전 점수가 이 값 미만이면 Claude 직접 비교를 생략 */
  preScoreMin: number;
  /** Claude 직접 비교 대상 상위 N */
  topN: number;
  /** 습득 시각이 분실 시각보다 이만큼(ms) 이전이면 제외 */
  timeMarginMs: number;
  /** 후보 풀 상한(최신순은 호출 측 책임, 엔진은 초과 시 앞에서부터 자름) */
  maxCandidates: number;
  /** 카테고리로 취급하는 프리셋 태그 슬러그 */
  categoryTags: readonly CategorySlug[];
  /**
   * 민감 사진 노출 정책 [사용자 결정]. 학생증·지갑·카드 태그/키워드, 사용자 "민감" 표시(sensitiveHint), 또는 AI 가 감지한 민감 정보가 있으면
   * mode 를 적용한다. 기본 SKIP(사진을 AI 로 보내지 않고 태그·위치만 사용). BLUR(흐린 사본)·SEND(원본 사본)는 명시적 선택일 때만.
   */
  /**
   * 색상 규칙 [사용자 결정 + 가정/제안]: 두 사진의 색이 비슷하면 사진 점수의 하한을 올린다(AI 오인식·각도 차이 보완).
   * floor=0 이면 끈다. 색이 정반대면 가점 없음(mismatchFactor 로 감점도 가능, 기본 1=유지).
   */
  color: {
    /** 색이 같을 때 사진 점수의 하한(유사도에 비례). 0 이면 규칙 꺼짐 */
    floor: number;
    /** 하한을 적용하는 최소 색 유사도(0.5=인접 색까지) */
    minSim: number;
    /** 속성 신뢰도 하한(이 미만이면 색 규칙 미적용) */
    minConfidence: number;
    /** 색이 명확히 다를 때 사진 점수에 곱하는 계수(1=유지) */
    mismatchFactor: number;
    /** 안전장치 [사용자 승인, 기본 0.5]: 색 하한만으로 올라간 쌍은 AI 원점수가 이 값 이상일 때만 AUTO, 아니면 CANDIDATE. 0 이면 꺼짐 */
    autoMinAi: number;
  };
  /** 완화 옵션(기본 0=꺼짐): AUTO 에 필요한 위치·태그 최소 점수 */
  autoMin: { location: number; tag: number };
  exposure: {
    mode: SensitiveMode;
    /** 민감하다고 간주하는 태그(정규화 전 표기, 프리셋 슬러그 또는 자유 태그) */
    tags: string[];
    /** 이 신뢰도 이상으로 감지되면 민감 사진으로 취급 */
    detectMinConfidence: number;
    /** 제목·설명에 이 단어가 있으면 태그가 없어도 "예상 민감"으로 취급(첫 전송 전에 건너뜀). 빈 배열이면 끔 */
    keywords: string[];
  };
  /** 선택 옵션(기본 꺼짐): 민감 글(예상·감지)이 낀 쌍은 AUTO 가 되지 않고 CANDIDATE 까지만 */
  sensitiveNeverAuto: boolean;
  models: { extract: string; compare: string };
  ai: {
    /** 전역 일일 호출 상한(실제 HTTP 호출 기준, KST 자정 리셋) */
    dailyLimit: number;
    timeoutMs: number;
    maxTokens: number;
    concurrency: number;
    /** 재시도 대기(ms). 길이 = 최대 재시도 횟수 */
    backoffMs: readonly number[];
  };
  image: {
    /** AI 전송용 사본의 긴 변(px) */
    maxSide: number;
    /** AI 전송 전 허용하는 디코딩 후 최대 바이트 */
    maxBytes: number;
    /** prepareImageForAi가 받는 원본 최대 바이트 */
    maxInputBytes: number;
  };
}

export const DEFAULT_CATEGORY_TAGS: readonly CategorySlug[] = [
  'smartphone',
  'earphones',
  'student_id',
  'wallet',
  'bag',
  'keys',
  'laptop',
];

/** 문서 기본값. 모델 ID는 [가정/제안]이며 16절 #11이 확정될 때까지 환경변수로 교체한다 */
export const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

function num(v: string | undefined, fallback: number, opts: { min?: number; max?: number } = {}): number {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (opts.min !== undefined && n < opts.min) return fallback;
  if (opts.max !== undefined && n > opts.max) return fallback;
  return n;
}

function parseMode(v: string | undefined): SensitiveMode {
  const up = v?.trim().toUpperCase();
  // [사용자 결정] 기본 SKIP: 민감 사진은 AI 로 보내지 않는다. BLUR/SEND 는 명시적 선택일 때만. 알 수 없는 값도 SKIP
  return up === 'SEND' || up === 'BLUR' || up === 'SKIP' ? up : 'SKIP';
}

export function loadMatchingConfig(env: Record<string, string | undefined> = process.env): MatchingConfig {
  const frac = { min: 0, max: 1 };
  return {
    weights: {
      // [사용자 결정] 사진 0.45 / 태그 0.30 / 위치 0.25 (합 1.0)
      photo: num(env.MATCH_W_PHOTO, 0.45, frac),
      location: num(env.MATCH_W_LOCATION, 0.25, frac),
      tag: num(env.MATCH_W_TAG, 0.3, frac),
    },
    noPhotoWeights: {
      location: num(env.MATCH_W_NOPHOTO_LOCATION, 0.5, frac),
      tag: num(env.MATCH_W_NOPHOTO_TAG, 0.5, frac),
    },
    // 1 초과 값(예: 2)은 점수가 도달할 수 없으므로 해당 모드의 AUTO를 끈다(후보 표시만)
    autoThreshold: num(env.MATCH_AUTO_THRESHOLD, 0.8, { min: 0, max: 2 }),
    autoThresholdNoPhoto: num(env.MATCH_AUTO_THRESHOLD_NOPHOTO, 0.85, { min: 0, max: 2 }),
    candidateThreshold: num(env.MATCH_CANDIDATE_THRESHOLD, 0.6, frac),
    preScoreMin: num(env.MATCH_PRESCORE_MIN, 0.45, frac),
    topN: Math.floor(num(env.MATCH_TOP_N, 5, { min: 1, max: 50 })),
    timeMarginMs: num(env.MATCH_TIME_MARGIN_HOURS, 24, { min: 0 }) * 3_600_000,
    maxCandidates: Math.floor(num(env.MATCH_MAX_CANDIDATES, 200, { min: 1 })),
    categoryTags: DEFAULT_CATEGORY_TAGS,
    color: {
      floor: num(env.MATCH_COLOR_FLOOR, 0.7, frac),
      minSim: num(env.MATCH_COLOR_MIN_SIM, 0.5, frac),
      minConfidence: num(env.MATCH_COLOR_MIN_CONF, 0.5, frac),
      mismatchFactor: num(env.MATCH_COLOR_MISMATCH_FACTOR, 1, frac),
      autoMinAi: num(env.MATCH_COLOR_AUTO_MIN_AI, 0.5, frac), // [사용자 승인] 기본 켬. 0 이면 꺼짐
    },
    autoMin: {
      location: num(env.MATCH_AUTO_MIN_LOCATION, 0, frac),
      tag: num(env.MATCH_AUTO_MIN_TAG, 0, frac),
    },
    exposure: {
      mode: parseMode(env.AI_SENSITIVE_MODE),
      tags: (env.AI_SENSITIVE_TAGS ?? 'student_id,wallet,카드').split(',').map((t) => t.trim()).filter(Boolean),
      detectMinConfidence: num(env.AI_SENSITIVE_MIN_CONF, 0.5, frac),
      keywords:
        env.AI_SENSITIVE_KEYWORDS === undefined
          ? ['학생증', '신분증', '카드', '면허증', '운전면허', '여권', '주민등록', '지갑']
          : env.AI_SENSITIVE_KEYWORDS.split(',').map((t) => t.trim()).filter(Boolean),
    },
    sensitiveNeverAuto: env.MATCH_SENSITIVE_NEVER_AUTO?.trim().toLowerCase() === 'true',
    models: {
      extract: env.CLAUDE_MODEL_EXTRACT?.trim() || DEFAULT_MODEL,
      compare: env.CLAUDE_MODEL_COMPARE?.trim() || DEFAULT_MODEL,
    },
    ai: {
      dailyLimit: Math.floor(num(env.AI_DAILY_CALL_LIMIT, 500, { min: 0 })),
      timeoutMs: num(env.AI_TIMEOUT_MS, 30_000, { min: 1000 }),
      maxTokens: Math.floor(num(env.AI_MAX_TOKENS, 400, { min: 50 })),
      concurrency: Math.floor(num(env.AI_CONCURRENCY, 2, { min: 1, max: 16 })),
      backoffMs: [2000, 8000, 30000],
    },
    image: {
      maxSide: Math.floor(num(env.AI_IMAGE_MAX_SIDE, 1024, { min: 256, max: 1568 })),
      maxBytes: Math.floor(num(env.AI_IMAGE_MAX_BYTES, 5 * 1024 * 1024, { min: 1024 })),
      maxInputBytes: 10 * 1024 * 1024,
    },
  };
}
