/**
 * 색상 규칙: 사진 점수에 "색이 비슷하면 점수가 높게 나와야 한다"는 사용자 결정을 반영한다. 순수 함수.
 *
 * 입력은 **추출된 속성(colors)** 뿐이다(사진 픽셀·AI 점수를 직접 신뢰하지 않음). 규칙은 사진 점수를 "올리는 하한"으로만 작동하므로
 * AI 점수·상한(capLikelihood)·브랜드 불일치·카테고리 충돌 등 기존 방어를 약화시키지 않도록 가드를 둔다:
 *  - 카테고리가 서로 다르게 확인된 경우(둘 다 'other' 아님) 하한 미적용(제외 규칙과 같은 기준, 'other' 는 충돌이 아님)
 *  - 알려진 브랜드가 서로 다르면 하한 미적용
 *  - 속성 신뢰도가 낮으면(기본 0.5 미만) 미적용
 *  - 하한 값은 설정(기본 0.70)을 넘지 않는다. 색 하한만으로 AUTO 가 되는 부작용은 완화 옵션(MATCH_COLOR_AUTO_MIN_AI 등)으로 제어한다.
 */
import { baseNormalize, type TagNormalizer } from './tags.js';
import type { PhotoAttributes } from './types.js';
import type { MatchingConfig } from './weights.js';

/** 인접 색(부분 유사 0.5). 키는 정규화된 대표 색 이름, 대칭으로 취급한다 */
const NEAR_PAIRS: readonly [string, string][] = [
  ['흰색', '회색'],
  ['검정', '회색'],
  ['흰색', '베이지'],
  ['은색', '회색'],
  ['은색', '흰색'],
  ['갈색', '베이지'],
  ['남색', '파란색'],
  ['남색', '검정'],
  ['금색', '노란색'],
];
const NEAR = new Set(NEAR_PAIRS.flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]));

function tokens(colors: readonly string[], norm: TagNormalizer): string[] {
  return [...new Set(colors.map((c) => norm(c)).filter((c) => baseNormalize(c).length > 0))];
}

const tokenSim = (a: string, b: string): number => (a === b ? 1 : NEAR.has(`${a}|${b}`) ? 0.5 : 0);

/**
 * 두 색 목록의 유사도(0~1, 정보 없음 null). 작은 쪽 색 각각이 상대의 가장 가까운 색과 얼마나 닮았는지의 평균이다.
 * 같은 색=1, 인접 색(흰색↔회색 등)=0.5, 정반대·무관=0. 다중 색은 [흰색] vs [흰색,회색] 처럼 한쪽이 다른 쪽에 포함되면 1.
 */
export function colorSimilarity(a: readonly string[], b: readonly string[], norm: TagNormalizer): number | null {
  const ta = tokens(a, norm);
  const tb = tokens(b, norm);
  if (!ta.length || !tb.length) return null;
  const [small, big] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const best = small.map((t) => Math.max(...big.map((u) => tokenSim(t, u))));
  return best.reduce((x, y) => x + y, 0) / best.length;
}

export type ColorRuleKind = 'FLOOR' | 'MISMATCH' | 'NONE';

export interface ColorRuleResult {
  photo: number;
  rule: ColorRuleKind;
  /** 색 유사도(계산됐을 때) */
  colorSimilarity?: number;
}

const known = (brand: string) => {
  const b = baseNormalize(brand);
  return b.length > 0 && b !== 'unknown';
};

/** 두 속성의 카테고리가 서로 다르게 확인되었는가(둘 다 알려져 있고 'other' 가 아님) */
const categoryConflict = (a: PhotoAttributes, b: PhotoAttributes) => a.category !== b.category && a.category !== 'other' && b.category !== 'other';

const brandMismatch = (a: PhotoAttributes, b: PhotoAttributes) => known(a.brand) && known(b.brand) && baseNormalize(a.brand) !== baseNormalize(b.brand);

/**
 * 색상 규칙 적용. photo 는 AI 비교 점수(상한 처리 후) 또는 속성 점수.
 * - 색이 비슷(유사도 ≥ minSim): photo = max(photo, floor × 유사도)   [FLOOR, 가드 통과 시]
 * - 색이 명확히 다름(유사도 0): photo × mismatchFactor(기본 1=유지, 가점 없음)  [MISMATCH]
 * - 그 외/정보 없음/가드 차단: 변경 없음 [NONE]
 */
export function applyColorRule(
  photo: number,
  a: PhotoAttributes | null,
  b: PhotoAttributes | null,
  cfg: MatchingConfig,
  norm: TagNormalizer,
): ColorRuleResult {
  const none: ColorRuleResult = { photo, rule: 'NONE' };
  if (!a || !b) return none;
  const { floor, minSim, minConfidence, mismatchFactor } = cfg.color;
  if (floor <= 0 && mismatchFactor >= 1) return none; // 규칙 꺼짐
  if (Math.min(a.confidence, b.confidence) < minConfidence) return none;
  const sim = colorSimilarity(a.colors, b.colors, norm);
  if (sim === null) return none;
  if (sim === 0) return { photo: photo * mismatchFactor, rule: 'MISMATCH', colorSimilarity: 0 };
  if (floor > 0 && sim >= minSim && !categoryConflict(a, b) && !brandMismatch(a, b)) {
    const f = floor * sim;
    if (photo < f) return { photo: f, rule: 'FLOOR', colorSimilarity: sim };
  }
  return { photo, rule: 'NONE', colorSimilarity: sim };
}
