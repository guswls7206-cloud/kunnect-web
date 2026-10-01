/**
 * 오프라인 평가 하네스(순수 계산, Claude 호출 없음).
 * 사진 신호 = 속성 점수(attributeScore)로 대체한다. 실제로는 상위 N에 Claude 직접 비교 점수가 들어가므로
 * 이 평가는 "속성이 정확하다고 가정한 때의 상한에 가까운 추정"이며 실제 AI 오류는 반영하지 못한다.
 */
import { applyColorRule } from '../color.js';
import { attributeScore, composeScore, exclusionReason, locationScore, mergeAttributes } from '../scoring.js';
import { createTagNormalizer, DEFAULT_IMPLIED, tagSimilarity } from '../tags.js';
import { loadMatchingConfig, type MatchingConfig } from '../weights.js';
import { DATASET, type EvalPair } from './dataset.js';
import type { PostInput } from '../types.js';

const norm = createTagNormalizer();
export const BASE = loadMatchingConfig({});

export type Mode = 'photo' | 'nophoto';

export interface Scored {
  pair: EvalPair;
  excluded: boolean;
  score: number;
}

export function scoreOne(lost: PostInput, found: PostInput, cfg: MatchingConfig, mode: Mode): { excluded: boolean; score: number } {
  if (exclusionReason(lost, found, cfg)) return { excluded: true, score: 0 };
  const location = locationScore(lost.location, found.location);
  const tag = tagSimilarity(
    { preset: lost.presetTags, custom: lost.customTags },
    { preset: found.presetTags, custom: found.customTags },
    norm,
    DEFAULT_IMPLIED,
  );
  if (mode === 'photo') {
    const a = mergeAttributes(lost.photos.map((p) => p.attributes));
    const b = mergeAttributes(found.photos.map((p) => p.attributes));
    if (!a || !b) throw new Error('photo 모드는 양쪽 속성이 필요합니다');
    // 색상 규칙(cfg.color.floor=0 이면 꺼짐)까지 적용한 사진 점수
    const photo = applyColorRule(attributeScore(a, b, norm), a, b, cfg, norm).photo;
    return { excluded: false, score: composeScore({ location, tag, photo }, cfg) };
  }
  return { excluded: false, score: composeScore({ location, tag }, cfg) };
}

export function scoreAll(pairs: EvalPair[], cfg: MatchingConfig, mode: Mode): Scored[] {
  const use = mode === 'photo' ? pairs.filter((p) => p.bothPhotos) : pairs;
  return use.map((pair) => ({ pair, ...scoreOne(pair.lost, pair.found, cfg, mode) }));
}

export interface Metrics {
  n: number;
  pos: number;
  neg: number;
  autoTP: number;
  autoFP: number;
  autoFPNear: number;
  autoPrecision: number | null;
  autoRecall: number;
  /** 정답이 아닌 쌍 중 AUTO로 판정된 비율 */
  falseAutoRate: number;
  candTP: number;
  candFP: number;
  candPrecision: number | null;
  candRecall: number;
}

const ratio = (a: number, b: number): number | null => (b === 0 ? null : a / b);

export function metrics(scored: Scored[], auto: number, cand: number): Metrics {
  let pos = 0, neg = 0, autoTP = 0, autoFP = 0, autoFPNear = 0, candTP = 0, candFP = 0;
  for (const s of scored) {
    const isPos = s.pair.label === 'TRUE';
    isPos ? pos++ : neg++;
    const a = !s.excluded && s.score >= auto;
    const c = !s.excluded && s.score >= cand;
    if (a) isPos ? autoTP++ : (autoFP++, s.pair.label === 'NEAR' && autoFPNear++);
    if (c) isPos ? candTP++ : candFP++;
  }
  return {
    n: scored.length, pos, neg, autoTP, autoFP, autoFPNear,
    autoPrecision: ratio(autoTP, autoTP + autoFP),
    autoRecall: pos === 0 ? 0 : autoTP / pos,
    falseAutoRate: neg === 0 ? 0 : autoFP / neg,
    candTP, candFP,
    candPrecision: ratio(candTP, candTP + candFP),
    candRecall: pos === 0 ? 0 : candTP / pos,
  };
}

const pct = (v: number | null) => (v === null ? '–' : `${(v * 100).toFixed(0)}%`);

export function row(label: string, m: Metrics): string {
  return `| ${label} | ${m.n} | ${m.autoTP}/${m.autoFP} | ${pct(m.autoPrecision)} | ${pct(m.autoRecall)} | ${pct(m.falseAutoRate)} | ${m.candTP}/${m.candFP} | ${pct(m.candPrecision)} | ${pct(m.candRecall)} |`;
}

export const HEADER =
  '| 설정 | 쌍 수 | AUTO TP/FP | AUTO 정밀도 | AUTO 재현율 | false-AUTO율 | 후보 이상 TP/FP | 후보 정밀도 | 후보 재현율 |\n|---|---|---|---|---|---|---|---|---|';

// ── 풀 평가: 새 분실글 1건당, 기존 습득글 전체와 비교했을 때의 오탐 알림 수 ──
export interface PoolResult {
  lostCount: number;
  foundPool: number;
  /** 분실글당 평균 false-AUTO 수 */
  falseAutoPerLost: number;
  /** 정답 습득글이 AUTO가 된 비율 */
  trueAutoRate: number;
  /** 정답이 후보 이상(≥0.60)이 된 비율 */
  trueCandRate: number;
  /** 분실글당 평균 후보 이상 오탐 수 */
  falseCandPerLost: number;
}

/**
 * 실제 제품 정책(혼합): 양쪽에 사진 속성이 있으면 사진 모드(autoPhoto), 아니면 사진 없음 모드(autoNoPhoto).
 * capNoPhoto=true면 사진 없음 쌍은 AUTO 불가(후보까지만).
 */
export function poolEval(
  cfg: MatchingConfig,
  opts: { autoPhoto: number; autoNoPhoto: number; capNoPhoto?: boolean },
): PoolResult {
  const trues = DATASET.filter((p) => p.label === 'TRUE');
  const founds = DATASET.map((p) => ({ id: p.id, f: p.found }));
  let fa = 0, fc = 0, ta = 0, tc = 0;
  for (const t of trues) {
    for (const { id, f } of founds) {
      const lost = t.lost;
      const bothAttrs = lost.photos.length > 0 && f.photos.length > 0;
      const mode: Mode = bothAttrs ? 'photo' : 'nophoto';
      // 풀 안에서는 사진 없는 습득글/분실글이 섞이므로, 사진 없음 쌍은 사진을 떼고 계산한다
      const l = mode === 'photo' ? lost : { ...lost, photos: [] };
      const ff = mode === 'photo' ? f : { ...f, photos: [] };
      const r = scoreOne(l, ff, cfg, mode);
      if (r.excluded) continue;
      const auto = mode === 'photo' ? opts.autoPhoto : opts.autoNoPhoto;
      const isAuto = r.score >= auto && !(mode === 'nophoto' && opts.capNoPhoto);
      const isCand = r.score >= cfg.candidateThreshold;
      const isTrue = id === t.id;
      if (isTrue) {
        if (isAuto) ta++;
        if (isCand) tc++;
      } else {
        if (isAuto) fa++;
        if (isCand) fc++;
      }
    }
  }
  return {
    lostCount: trues.length,
    foundPool: founds.length,
    falseAutoPerLost: fa / trues.length,
    trueAutoRate: ta / trues.length,
    trueCandRate: tc / trues.length,
    falseCandPerLost: fc / trues.length,
  };
}
