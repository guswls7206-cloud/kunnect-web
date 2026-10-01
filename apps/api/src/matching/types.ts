/**
 * KUnnect 매칭 엔진 공개 인터페이스.
 *
 * - DB/서버에 의존하지 않는다. 입력·출력은 모두 일반 객체(JSON 직렬화 가능)다.
 * - API 서버(kunnect-af)는 DB 행을 아래 `PostInput`으로 변환해 엔진을 호출하고,
 *   결과(`MatchResult`)를 matches 테이블/알림에 반영한다.
 * - 기준 문서: docs/dev-plan-backend.md 6절, README.md 5절.
 */

// ───────────────────────── 입력 ─────────────────────────

export type PostType = 'LOST' | 'FOUND';

/** 카테고리 프리셋 태그 슬러그. 태그 시드의 카테고리 플래그와 일치해야 한다. */
export type CategorySlug =
  | 'smartphone'
  | 'earphones'
  | 'student_id'
  | 'wallet'
  | 'bag'
  | 'keys'
  | 'laptop';

/** 위치 시드(locations) 한 행에 대응. 좌표/그룹은 없을 수 있다. */
export interface LocationRef {
  id: string;
  /** 같은 건물의 다른 층을 식별하기 위한 건물 ID */
  buildingId: string;
  buildingName: string;
  floor?: number | null;
  /** 인접 건물 묶음 ID */
  groupId?: string | null;
  lat?: number | null;
  lng?: number | null;
}

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

export interface PhotoInput {
  id: string;
  /** AI 전송용 사본(긴 변 ≤1024px 권장). base64 문자열(접두사 data: 없음). 없으면 속성만 사용 */
  base64?: string;
  mediaType?: ImageMediaType;
  /** 이미 추출·캐시된 속성(post_photos.ai_attributes). 있으면 재추출하지 않는다 */
  attributes?: PhotoAttributes | null;
}

export interface PostInput {
  id: string;
  type: PostType;
  authorId?: string;
  title: string;
  description?: string;
  /** 프리셋 태그 슬러그(카테고리 태그 포함). 예: ['earphones', 'black'] */
  /** 사용자가 "민감한 물건"(학생증·카드·신분증 등)이라고 표시했는가. 있으면 태그와 무관하게 민감 정책을 적용한다 */
  sensitiveHint?: boolean;
  presetTags: string[];
  /** 사용자 정의 태그 원문 */
  customTags: string[];
  /** 분실/습득 시각 (ISO 8601 문자열) */
  occurredAt: string;
  location: LocationRef | null;
  photos: PhotoInput[];
  // 주의: 습득글의 비공개 식별 특징(hidden_features)은 엔진에 전달하지 않는다(근거 문구로 노출될 위험).
}

// ───────────────────────── 사진 속성 ─────────────────────────

export const ATTRIBUTE_CATEGORIES = [
  'smartphone',
  'earphones',
  'student_id',
  'wallet',
  'bag',
  'keys',
  'laptop',
  'clothing',
  'other',
] as const;
export type AttributeCategory = (typeof ATTRIBUTE_CATEGORIES)[number];

/** 사진에서 감지한 민감 정보 종류. 내용(이름·번호 등)은 절대 옮겨 적지 않고 종류만 표시한다. */
export type SensitiveKind = 'ID_CARD' | 'CARD_NUMBER' | 'FACE' | 'DOCUMENT_TEXT' | 'OTHER';
export const SENSITIVE_KINDS: readonly SensitiveKind[] = ['ID_CARD', 'CARD_NUMBER', 'FACE', 'DOCUMENT_TEXT', 'OTHER'];

export interface SensitiveFinding {
  /** 감지된 종류(없으면 빈 배열이 아니라 이 객체 자체가 undefined) */
  kinds: SensitiveKind[];
  /** 0~1, 코드에서 clamp. 모델이 스스로 매긴 값이라 보정되지 않았다 */
  confidence: number;
}

/**
 * AI 에 사진이 어떻게 전달되었는가.
 * SENT: 원본(사본) 그대로 / BLURRED: 강하게 흐려서 / SKIPPED: 보내지 않음(태그 정보만 사용)
 */
export type PhotoExposure = 'SENT' | 'BLURRED' | 'SKIPPED';

/** post_photos.ai_attributes JSON. 모든 값은 모델 출력이므로 환각 가능성이 있다. */
export interface PhotoAttributes {
  category: AttributeCategory;
  colors: string[];
  /** 불확실하면 'unknown' */
  brand: string;
  shape: string;
  features: string[];
  has_sensitive_info: boolean;
  /** 민감 정보 감지 결과(종류·신뢰도). 없으면 감지되지 않음. has_sensitive_info 는 호환용으로 유지된다 */
  sensitive?: SensitiveFinding;
  /** 0~1, 코드에서 clamp */
  confidence: number;
}

export type ExtractStatus = 'OK' | 'SKIPPED' | 'FAILED';

export interface PhotoExtraction {
  photoId: string;
  status: ExtractStatus;
  attributes: PhotoAttributes | null;
  /** FAILED/SKIPPED 사유(키 미설정, 일일 상한, 거절, SENSITIVE 등). 비밀 정보 없음 */
  reason?: string;
  /** 이 사진이 AI 에 어떻게 전달되었는가(SKIPPED 면 보내지 않음). 호출이 없었던 경우(캐시 등)는 undefined */
  exposure?: PhotoExposure;
  /** 이 추출에서 감지된 민감 정보(attributes.sensitive 와 같은 값). 호출 측이 사진 저장/표시 시 흐림 처리 판단에 쓴다 */
  sensitive?: SensitiveFinding;
}

export interface ExtractionResult {
  postId: string;
  photos: PhotoExtraction[];
}

// ───────────────────────── 출력 ─────────────────────────

/** AUTO: 자동 연결+알림 / CANDIDATE: 후보 표시만 / IGNORE: 무시 또는 제외 */
export type MatchGrade = 'AUTO' | 'CANDIDATE' | 'IGNORE';

export type ExcludeReason =
  | 'SAME_TYPE'
  | 'SAME_AUTHOR'
  | 'CATEGORY_CONFLICT'
  | 'TIME_BEFORE_LOST';

export interface MatchBreakdown {
  /** 사진 신호가 제외된 경우(NO_PHOTO) undefined. 색상 규칙이 적용된 최종 사진 점수 */
  photo?: number;
  /** 색상 규칙 적용 전 사진 점수(AI 비교 또는 속성 점수). photo 와 다르면 색 규칙이 작동한 것 */
  photoRaw?: number;
  /** 두 사진의 색 유사도(0~1). 색 정보가 없으면 undefined */
  colorSimilarity?: number;
  location: number;
  tag: number;
}

/** 사진 점수의 출처 */
export type PhotoScoreSource = 'AI_COMPARE' | 'ATTRIBUTES' | 'NONE';

export interface MatchResult {
  lostPostId: string;
  foundPostId: string;
  /** 0~1 (소수 4자리 반올림) */
  score: number;
  grade: MatchGrade;
  breakdown: MatchBreakdown;
  /** WITH_PHOTO: 양쪽 사진 속성 있음 / NO_PHOTO: 사진 신호 제외·재정규화 */
  mode: 'WITH_PHOTO' | 'NO_PHOTO';
  /** 이 결과에 적용된 자동 알림 임계값(0.80 또는 0.85) */
  autoThreshold: number;
  photoSource: PhotoScoreSource;
  /** 색상 규칙 결과: FLOOR(하한으로 올림) / MISMATCH(색이 정반대, 가점 없음) / NONE. 사진 신호가 없으면 undefined */
  colorRule?: 'FLOOR' | 'MISMATCH' | 'NONE';
  /** AI 비교 근거 한 줄(최대 80자). 없으면 undefined */
  aiReason?: string;
  /**
   * AI 단계를 건너뛰었거나 실패해 로컬 점수만 쓴 경우 true.
   * 이 경우 AUTO는 CANDIDATE로 강등되어 알림 승격이 보류된다.
   */
  degraded: boolean;
  /** 제외된 경우만. score=0, grade=IGNORE */
  excluded?: ExcludeReason;
}

export interface RankedMatch extends MatchResult {
  /** 후보 post id (입력 post의 반대 유형) */
  candidateId: string;
}

// ───────────────────────── 엔진 ─────────────────────────

export interface RankOptions {
  /** Claude 직접 비교 대상 상위 N (기본 5) */
  topN?: number;
}

export interface MatchingEngine {
  /**
   * 글의 사진에서 속성 JSON을 추출한다(Claude 비전, 글당 1호출에 사진 묶음).
   * 이미 attributes가 있는 사진은 건너뛴다(OK로 반환). 실패해도 throw하지 않고 FAILED/SKIPPED로 반환한다.
   * 호출 측은 OK 결과를 post_photos.ai_attributes에 저장해야 한다.
   */
  extractAttributes(post: PostInput): Promise<ExtractionResult>;

  /**
   * 분실글-습득글 한 쌍을 평가한다. 제외 조건이면 excluded 결과를 반환한다.
   * 사전 점수가 낮으면 Claude 비교를 생략한다. throw하지 않는다(AI 오류는 degraded로 반영).
   */
  matchPair(lost: PostInput, found: PostInput): Promise<MatchResult>;

  /**
   * 한 글과 후보들(반대 유형)을 비교해 등급·점수 순으로 반환한다.
   * 로컬 사전 점수로 정렬 후 상위 topN에만 Claude 직접 비교를 수행한다.
   * 정렬: 등급(AUTO>CANDIDATE>IGNORE) 우선, 같은 등급 내 점수 내림차순.
   * excluded 후보는 결과에 포함하지 않는다.
   */
  rankCandidates(
    post: PostInput,
    candidates: PostInput[],
    opts?: RankOptions,
  ): Promise<RankedMatch[]>;
}

export interface EngineConfigSummary {
  weights: { photo: number; location: number; tag: number };
  noPhotoWeights: { location: number; tag: number };
  autoThreshold: number;
  autoThresholdNoPhoto: number;
  candidateThreshold: number;
  topN: number;
}
