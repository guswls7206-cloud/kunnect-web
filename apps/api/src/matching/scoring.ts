/** 점수 계산 순수 함수(위치·태그·속성·가중 합산·판정·제외 규칙). Claude 호출 없음. */
import type {
  CategorySlug,
  ExcludeReason,
  LocationRef,
  MatchGrade,
  PhotoAttributes,
  PostInput,
  SensitiveFinding,
} from './types.js';
import type { MatchingConfig } from './weights.js';
import { baseNormalize, jaccard, type TagNormalizer } from './tags.js';

export const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
export const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

// ───────────── 위치 ─────────────

const EARTH_RADIUS_M = 6_371_000;

export function haversineMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * 같은 위치 ID=1.0 / 같은 건물·다른 층=0.8 / 같은 인접 그룹=0.65 /
 * 그 외 좌표 거리 d(m): max(0, 1 − d/500) × 0.6 (최대 0.5). 좌표 없으면 0. [가정/제안: 세부 수치]
 */
export function locationScore(a: LocationRef | null, b: LocationRef | null): number {
  if (!a || !b) return 0;
  if (a.id === b.id) return 1;
  if (a.buildingId === b.buildingId) return 0.8;
  if (a.groupId && b.groupId && a.groupId === b.groupId) return 0.65;
  if (isNum(a.lat) && isNum(a.lng) && isNum(b.lat) && isNum(b.lng)) {
    const d = haversineMeters(a.lat, a.lng, b.lat, b.lng);
    return Math.min(0.5, Math.max(0, 1 - d / 500) * 0.6);
  }
  return 0;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

// ───────────── 카테고리 / 제외 ─────────────

export function categoriesOf(post: PostInput, cfg: MatchingConfig): Set<CategorySlug> {
  const set = new Set<CategorySlug>();
  for (const t of post.presetTags) {
    const slug = t.trim().toLowerCase() as CategorySlug;
    if (cfg.categoryTags.includes(slug)) set.add(slug);
  }
  return set;
}

/** 양쪽에 카테고리 태그가 있고 교집합이 없으면 충돌 [가정]: 강한 감점 대신 제외(README 5.2와 차이, 보고 대상) */
export function hasCategoryConflict(a: PostInput, b: PostInput, cfg: MatchingConfig): boolean {
  const ca = categoriesOf(a, cfg);
  const cb = categoriesOf(b, cfg);
  if (ca.size === 0 || cb.size === 0) return false;
  for (const c of ca) if (cb.has(c)) return false;
  return true;
}

/** 제외 사유를 반환(없으면 null). 순서: 유형 → 작성자 → 시간 → 카테고리 */
export function exclusionReason(lost: PostInput, found: PostInput, cfg: MatchingConfig): ExcludeReason | null {
  if (lost.type !== 'LOST' || found.type !== 'FOUND') return 'SAME_TYPE';
  if (lost.authorId && found.authorId && lost.authorId === found.authorId) return 'SAME_AUTHOR';
  const lostAt = Date.parse(lost.occurredAt);
  const foundAt = Date.parse(found.occurredAt);
  if (Number.isFinite(lostAt) && Number.isFinite(foundAt) && foundAt < lostAt - cfg.timeMarginMs) {
    return 'TIME_BEFORE_LOST';
  }
  if (hasCategoryConflict(lost, found, cfg)) return 'CATEGORY_CONFLICT';
  return null;
}

// ───────────── 사진 속성 ─────────────

const UNKNOWN = 'unknown';
/** 알려진 브랜드끼리 불일치할 때 속성 점수에 곱하는 계수 */
export const BRAND_MISMATCH_FACTOR = 0.7;

/** 사진들의 민감 정보 감지를 합친다(종류 합집합, 신뢰도는 최댓값). 하나도 없으면 필드를 만들지 않는다 */
function mergeSensitive(items: readonly PhotoAttributes[]): { sensitive?: SensitiveFinding } {
  const found = items.map((i) => i.sensitive).filter((x): x is SensitiveFinding => !!x);
  if (!found.length) return {};
  return { sensitive: { kinds: [...new Set(found.flatMap((f) => f.kinds))], confidence: Math.max(...found.map((f) => f.confidence)) } };
}

/** 한 글의 여러 사진 속성을 하나로 합친다(카테고리·브랜드는 신뢰도 높은 쪽, 색·특징은 합집합) */
export function mergeAttributes(list: readonly (PhotoAttributes | null | undefined)[]): PhotoAttributes | null {
  const items = list.filter((x): x is PhotoAttributes => !!x);
  if (items.length === 0) return null;
  const best = [...items].sort((x, y) => y.confidence - x.confidence)[0]!;
  const brand = items.map((i) => i.brand).find((b) => b && b.toLowerCase() !== UNKNOWN) ?? UNKNOWN;
  return {
    category: best.category,
    colors: [...new Set(items.flatMap((i) => i.colors))],
    brand,
    shape: best.shape,
    features: [...new Set(items.flatMap((i) => i.features))],
    has_sensitive_info: items.some((i) => i.has_sensitive_info),
    ...mergeSensitive(items),
    confidence: clamp01(Math.max(...items.map((i) => i.confidence))),
  };
}

function tokens(texts: readonly string[], norm: TagNormalizer): Set<string> {
  const out = new Set<string>();
  for (const t of texts) {
    for (const w of t.split(/[\s,/]+/)) {
      const n = norm(w);
      if (n.length >= 2) out.add(n);
    }
  }
  return out;
}

/**
 * 속성 일치도(0~1): 카테고리 0.4, 색 0.3, 브랜드 0.2, 형태·특징 0.1.
 * 정보 부족(빈 값/unknown)은 0.5(중립)로 둔다 [가정/제안] — 한쪽만 모르는 경우 감점도 가점도 하지 않기 위함.
 * 마지막에 속성 신뢰도(confidence)로 중립 쪽 수축을 적용한다(낮은 신뢰도 속성이 점수를 좌우하지 않게).
 */
export function attributeScore(a: PhotoAttributes, b: PhotoAttributes, norm: TagNormalizer): number {
  let category: number;
  if (a.category === b.category) category = 1;
  else if (a.category === 'other' || b.category === 'other') category = 0.3;
  else category = 0;

  const ca = new Set(a.colors.map(norm).filter(Boolean));
  const cb = new Set(b.colors.map(norm).filter(Boolean));
  const colors = ca.size === 0 || cb.size === 0 ? 0.5 : jaccard(ca, cb);

  const ba = baseNormalize(a.brand);
  const bb = baseNormalize(b.brand);
  const brand = !ba || !bb || ba === UNKNOWN || bb === UNKNOWN ? 0.5 : ba === bb ? 1 : 0;

  const fa = tokens([a.shape, ...a.features], norm);
  const fb = tokens([b.shape, ...b.features], norm);
  const feat = fa.size === 0 || fb.size === 0 ? 0.5 : jaccard(fa, fb);

  let raw = clamp01(0.4 * category + 0.3 * colors + 0.2 * brand + 0.1 * feat);
  // 두 브랜드가 모두 식별되고 서로 다르면 다른 물건일 가능성이 크다(오프라인 평가 N08: 같은 색·위치의 Anker vs Samsung이 AUTO가 됨).
  // 브랜드 환각 가능성이 있어 0점 처리 대신 0.7배로만 감점한다 [가정/제안]
  if (brand === 0) raw *= BRAND_MISMATCH_FACTOR;
  // 모델 자체 신뢰도가 낮으면 점수를 중립(0.5)쪽으로 수축한다. 두 속성 중 낮은 신뢰도를 쓰고 하한 0.2로 완전 무시는 피한다 [가정/제안]
  return clamp01(0.5 + (raw - 0.5) * confidenceWeight(a, b));
}

/** 속성 신뢰도 → 점수 반영 비율(0.2~1) */
export function confidenceWeight(...attrs: PhotoAttributes[]): number {
  const c = Math.min(...attrs.map((x) => clamp01(x.confidence)));
  return Math.max(0.2, c);
}

/**
 * 한쪽만 사진(속성)이 있을 때 태그 점수 보정(최대 +0.1): 카테고리가 상대 카테고리 태그와 일치 +0.05,
 * 색이 상대 태그/설명 토큰에 있으면 +0.05. 불일치 감점은 하지 않는다(환각 위험).
 */
export function oneSidedTagBoost(
  attrs: PhotoAttributes,
  other: PostInput,
  cfg: MatchingConfig,
  norm: TagNormalizer,
): number {
  let boost = 0;
  const otherCats = categoriesOf(other, cfg);
  if (otherCats.size > 0 && otherCats.has(attrs.category as CategorySlug)) boost += 0.05;
  const words = tokens([...other.presetTags, ...other.customTags, other.title, other.description ?? ''], norm);
  if (attrs.colors.some((c) => words.has(norm(c)))) boost += 0.05;
  return boost * confidenceWeight(attrs);
}

// ───────────── 합산 / 판정 ─────────────

/** 가중 합산. photo가 undefined면 사진 신호 제외(위치·태그 재정규화 가중치) */
export function composeScore(
  s: { location: number; tag: number; photo?: number },
  cfg: MatchingConfig,
): number {
  if (s.photo === undefined) {
    const { location, tag } = cfg.noPhotoWeights;
    const total = location + tag;
    return round4(clamp01(total > 0 ? (location * s.location + tag * s.tag) / total : 0));
  }
  const { photo, location, tag } = cfg.weights;
  const total = photo + location + tag;
  return round4(clamp01(total > 0 ? (photo * s.photo + location * s.location + tag * s.tag) / total : 0));
}

export function autoThresholdFor(hasPhotoSignal: boolean, cfg: MatchingConfig): number {
  return hasPhotoSignal ? cfg.autoThreshold : cfg.autoThresholdNoPhoto;
}

/** 경계값 포함: score ≥ auto → AUTO, ≥ candidate → CANDIDATE. */
export function gradeFor(score: number, autoThreshold: number, cfg: MatchingConfig): MatchGrade {
  if (score >= autoThreshold) return 'AUTO';
  if (score >= cfg.candidateThreshold) return 'CANDIDATE';
  return 'IGNORE';
}
