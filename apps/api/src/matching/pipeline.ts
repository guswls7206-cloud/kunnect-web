/**
 * 매칭 파이프라인(엔진 구현). docs/dev-plan-backend.md 6.1 흐름 중 DB 의존 부분(후보 SQL 필터, 저장, 알림)을 제외한 순수 로직.
 *
 *  제외 규칙 → 로컬 점수(위치·태그·속성) → 사전 점수 pre → 상위 N만 Claude 직접 비교 → 가중 합산 → 판정
 *
 * AI 단계가 건너뛰어지거나 실패하면 `degraded=true`로 표시하고 AUTO를 CANDIDATE로 강등한다(알림 승격 보류).
 */
import { applyColorRule } from './color.js';
import { exposureFor, sensitivityOf } from './exposure.js';
import { capLikelihood } from './guard.js';
import { blurImageForPrivacy } from './image.js';
import { AiError, type AiClient, type AiImage, type CompareOutput } from './claude.js';
import {
  attributeScore,
  autoThresholdFor,
  composeScore,
  exclusionReason,
  gradeFor,
  locationScore,
  mergeAttributes,
  oneSidedTagBoost,
  round4,
} from './scoring.js';
import { createTagNormalizer, tagSimilarity, type TagNormalizer } from './tags.js';
import type {
  EngineConfigSummary,
  ExtractionResult,
  MatchingEngine,
  MatchResult,
  PhotoAttributes,
  PhotoExtraction,
  PhotoInput,
  PostInput,
  RankedMatch,
  RankOptions,
} from './types.js';
import { loadMatchingConfig, type MatchingConfig } from './weights.js';

export interface EngineOptions {
  /** null/undefined면 AI 없이 로컬 점수만 사용(키 미설정 개발 환경) */
  client?: AiClient | null;
  config?: MatchingConfig;
  normalizer?: TagNormalizer;
}

/** AI 비교 단계의 결과 상태 */
type AiOutcome =
  | 'DONE'
  | 'SKIPPED_LOW' // 사전 점수 낮음(정상 생략)
  | 'NOT_TOPN' // 상위 N 밖
  | 'UNAVAILABLE' // 클라이언트 없음/이미지 데이터 없음
  | 'FAILED' // 호출 실패(상한·거절·오류 포함)
  | 'NOT_APPLICABLE'; // 한쪽 이상 사진 없음

interface Local {
  lost: PostInput;
  found: PostInput;
  location: number;
  tag: number;
  attrL: PhotoAttributes | null;
  attrF: PhotoAttributes | null;
  attrScore?: number;
  pre: number;
  bothHavePhotos: boolean;
  /** 둘 중 하나라도 민감 글(예상·감지)인가 — MATCH_SENSITIVE_NEVER_AUTO 용 */
  sensitive: boolean;
  /** AI 로 보낼 후보 사진(원본 base64 보유분, 노출 정책은 전송 직전에 적용) */
  photos: { lost: PhotoInput[]; found: PhotoInput[] };
}

const MAX_IMAGES_PER_SIDE = 2;
const GRADE_RANK = { AUTO: 2, CANDIDATE: 1, IGNORE: 0 } as const;

export function createMatchingEngine(opts: EngineOptions = {}): MatchingEngine & {
  readonly config: EngineConfigSummary;
} {
  const cfg = opts.config ?? loadMatchingConfig();
  const client = opts.client ?? null;
  const norm = opts.normalizer ?? createTagNormalizer();

  const summary: EngineConfigSummary = {
    weights: { ...cfg.weights },
    noPhotoWeights: { ...cfg.noPhotoWeights },
    autoThreshold: cfg.autoThreshold,
    autoThresholdNoPhoto: cfg.autoThresholdNoPhoto,
    candidateThreshold: cfg.candidateThreshold,
    topN: cfg.topN,
  };

  const exposureOf = (p: PostInput) => exposureFor(p, cfg.exposure, norm);

  /** 노출 정책이 SKIP 인 글은 사진이 없는 것으로 취급한다(태그·위치만으로 평가. 의도된 것이라 degraded 가 아니다) */
  const view = (p: PostInput): PostInput => (p.photos.length > 0 && exposureOf(p) === 'SKIPPED' ? { ...p, photos: [] } : p);

  const photosOf = (p: PostInput): PhotoInput[] => p.photos.filter((x) => x.base64 && x.mediaType).slice(0, MAX_IMAGES_PER_SIDE);

  const blurCache = new WeakMap<PhotoInput, AiImage | null>();
  /** 흐림 정책이면 흐린 사본을, 아니면 그대로를 돌려준다. 흐림 실패(fail-closed)는 그 사진을 보내지 않는다. */
  async function exposeImage(p: PostInput, photo: PhotoInput): Promise<AiImage | null> {
    if (exposureOf(p) !== 'BLURRED') return { base64: photo.base64!, mediaType: photo.mediaType! };
    if (blurCache.has(photo)) return blurCache.get(photo)!;
    let out: AiImage | null = null;
    try {
      const b = await blurImageForPrivacy(Buffer.from(photo.base64!, 'base64'));
      out = { base64: b.buffer.toString('base64'), mediaType: b.mediaType };
    } catch {
      out = null; // 원본으로 대체하지 않는다
    }
    blurCache.set(photo, out);
    return out;
  }
  const exposedImages = async (p: PostInput, photos: PhotoInput[]): Promise<AiImage[]> =>
    (await Promise.all(photos.map((x) => exposeImage(p, x)))).filter((x): x is AiImage => !!x);

  function evaluateLocal(lostIn: PostInput, foundIn: PostInput): Local {
    const lost = view(lostIn);
    const found = view(foundIn);
    const attrL = mergeAttributes(lost.photos.map((p) => p.attributes));
    const attrF = mergeAttributes(found.photos.map((p) => p.attributes));

    const location = locationScore(lost.location, found.location);
    let tag = tagSimilarity(
      { preset: lost.presetTags, custom: lost.customTags },
      { preset: found.presetTags, custom: found.customTags },
      norm,
    );
    // 한쪽만 사진 속성이 있을 때 태그 점수만 보정(최대 +0.1)
    if (attrL && !attrF) tag += oneSidedTagBoost(attrL, found, cfg, norm);
    else if (attrF && !attrL) tag += oneSidedTagBoost(attrF, lost, cfg, norm);
    tag = Math.min(1, tag);

    // 속성 점수에도 색상 규칙을 적용해 사전 점수(비교 호출 여부)와 폴백 사진 점수가 최종 규칙과 일관되게 한다
    const attrScoreValue = attrL && attrF ? applyColorRule(attributeScore(attrL, attrF, norm), attrL, attrF, cfg, norm).photo : undefined;
    const pre = composeScore({ location, tag, photo: attrScoreValue }, cfg);
    return {
      lost,
      found,
      location,
      tag,
      attrL,
      attrF,
      attrScore: attrScoreValue,
      pre,
      bothHavePhotos: lost.photos.length > 0 && found.photos.length > 0,
      sensitive: [lostIn, foundIn].some((x) => {
        const s = sensitivityOf(x, cfg.exposure, norm);
        return s.expected || s.detected;
      }),
      photos: { lost: photosOf(lost), found: photosOf(found) },
    };
  }

  const aiEligible = (l: Local): boolean =>
    !!client && l.bothHavePhotos && l.photos.lost.length > 0 && l.photos.found.length > 0;

  async function runCompare(l: Local): Promise<{ outcome: AiOutcome; out?: CompareOutput }> {
    if (!client) return { outcome: 'UNAVAILABLE' };
    try {
      const [li, fi] = await Promise.all([exposedImages(l.lost, l.photos.lost), exposedImages(l.found, l.photos.found)]);
      if (!li.length || !fi.length) return { outcome: 'UNAVAILABLE' }; // 흐림 실패 등으로 보낼 사진이 없음
      const res = await client.compare({
        lost: { images: li, text: textOf(l.lost) },
        found: { images: fi, text: textOf(l.found) },
      });
      // AI가 준 점수는 신뢰하지 않고 근거·충돌·카테고리와 일관되게 상한 처리한다(인젝션 방어)
      const likelihood = capLikelihood(res.data.sameItemLikelihood, {
        matchingCount: res.data.matchingFeatures.length,
        conflictingCount: res.data.conflictingFeatures.length,
        categoryA: l.attrL?.category ?? null,
        categoryB: l.attrF?.category ?? null,
      });
      return { outcome: 'DONE', out: { ...res.data, sameItemLikelihood: likelihood } };
    } catch {
      // AiError(상한·거절·재시도 소진 등)뿐 아니라 예기치 못한 오류도 매칭 전체를 막지 않는다
      return { outcome: 'FAILED' };
    }
  }

  function finalize(l: Local, outcome: AiOutcome, ai?: CompareOutput): MatchResult {
    let photo: number | undefined;
    let photoSource: MatchResult['photoSource'] = 'NONE';
    if (outcome === 'DONE' && ai) {
      photo = ai.sameItemLikelihood;
      photoSource = 'AI_COMPARE';
    } else if (l.attrScore !== undefined) {
      photo = l.attrScore;
      photoSource = 'ATTRIBUTES';
    }

    // 색상 규칙: 추출된 속성의 색이 비슷하면 사진 점수의 하한을 올린다(AI 점수는 상한 처리 후 값 기준). 색이 정반대면 가점 없음
    const photoRaw = photo;
    let colorRule: MatchResult['colorRule'];
    let colorSim: number | undefined;
    if (photo !== undefined) {
      const cr = applyColorRule(photo, l.attrL, l.attrF, cfg, norm);
      photo = cr.photo;
      colorRule = cr.rule;
      colorSim = cr.colorSimilarity;
    }

    const score = composeScore({ location: l.location, tag: l.tag, photo }, cfg);
    const auto = autoThresholdFor(photo !== undefined, cfg);
    let grade = gradeFor(score, auto, cfg);

    const degraded = l.bothHavePhotos && outcome !== 'DONE' && outcome !== 'SKIPPED_LOW';
    if (degraded && grade === 'AUTO') grade = 'CANDIDATE';
    // 완화 옵션(기본 꺼짐): 색 하한만으로 AUTO 가 되지 않게, 위치·태그 최소 점수 요구
    if (grade === 'AUTO' && cfg.color.autoMinAi > 0 && colorRule === 'FLOOR' && (photoRaw ?? 0) < cfg.color.autoMinAi) grade = 'CANDIDATE';
    if (grade === 'AUTO' && (l.location < cfg.autoMin.location || l.tag < cfg.autoMin.tag)) grade = 'CANDIDATE';
    // 선택 옵션(기본 꺼짐): 민감 글이 낀 쌍은 후보까지만
    if (grade === 'AUTO' && cfg.sensitiveNeverAuto && l.sensitive) grade = 'CANDIDATE';

    const result: MatchResult = {
      lostPostId: l.lost.id,
      foundPostId: l.found.id,
      score,
      grade,
      breakdown: {
        location: round4(l.location),
        tag: round4(l.tag),
        ...(photo !== undefined ? { photo: round4(photo), photoRaw: round4(photoRaw!) } : {}),
        ...(colorSim !== undefined ? { colorSimilarity: round4(colorSim) } : {}),
      },
      mode: photo !== undefined ? 'WITH_PHOTO' : 'NO_PHOTO',
      autoThreshold: auto,
      photoSource,
      degraded,
      ...(colorRule ? { colorRule } : {}),
    };
    if (ai?.reasonKo) result.aiReason = ai.reasonKo;
    return result;
  }

  function excludedResult(lost: PostInput, found: PostInput, reason: NonNullable<MatchResult['excluded']>): MatchResult {
    return {
      lostPostId: lost.id,
      foundPostId: found.id,
      score: 0,
      grade: 'IGNORE',
      breakdown: { location: 0, tag: 0 },
      mode: 'NO_PHOTO',
      autoThreshold: cfg.autoThresholdNoPhoto,
      photoSource: 'NONE',
      degraded: false,
      excluded: reason,
    };
  }

  return {
    config: summary,

    async extractAttributes(post: PostInput): Promise<ExtractionResult> {
      const out: PhotoExtraction[] = [];
      const pending = post.photos.filter((p) => !p.attributes);
      for (const p of post.photos) {
        if (p.attributes) out.push({ photoId: p.id, status: 'OK', attributes: p.attributes, ...(p.attributes.sensitive ? { sensitive: p.attributes.sensitive } : {}) });
      }
      if (pending.length === 0) return { postId: post.id, photos: out };

      const exposure = exposureOf(post);
      const sendable = pending.filter((p) => p.base64 && p.mediaType);
      for (const p of pending.filter((x) => !(x.base64 && x.mediaType))) {
        out.push({ photoId: p.id, status: 'SKIPPED', attributes: null, reason: '이미지 데이터 없음' });
      }
      if (sendable.length > 0) {
        if (!client) {
          for (const p of sendable) out.push({ photoId: p.id, status: 'SKIPPED', attributes: null, reason: 'AI 미설정' });
        } else if (exposure === 'SKIPPED') {
          // 민감 글: 사진을 AI 로 보내지 않는다(태그·위치만 사용). 원본이 한 번도 나가지 않는다
          for (const p of sendable) out.push({ photoId: p.id, status: 'SKIPPED', attributes: null, reason: 'SENSITIVE', exposure: 'SKIPPED' });
        } else {
          const images = (await Promise.all(sendable.map(async (p) => ({ p, img: await exposeImage(post, p) })))).filter((x): x is { p: PhotoInput; img: AiImage } => !!x.img);
          const blurFailed = sendable.filter((p) => !images.some((x) => x.p === p));
          for (const p of blurFailed) out.push({ photoId: p.id, status: 'SKIPPED', attributes: null, reason: 'BLUR_FAILED', exposure: 'SKIPPED' });
          if (images.length > 0) {
            try {
              const res = await client.extractAttributes(images.map((x) => x.img));
              // 같은 글의 사진들은 한 호출로 종합한 동일 속성을 공유한다
              for (const { p } of images) {
                out.push({
                  photoId: p.id,
                  status: 'OK',
                  attributes: res.data,
                  exposure,
                  ...(res.data.sensitive ? { sensitive: res.data.sensitive } : {}),
                });
              }
            } catch (e) {
              const reason = e instanceof AiError ? e.kind : 'ERROR';
              for (const { p } of images) out.push({ photoId: p.id, status: 'FAILED', attributes: null, reason, exposure });
            }
          }
        }
      }
      const order = new Map(post.photos.map((p, i) => [p.id, i]));
      out.sort((x, y) => (order.get(x.photoId) ?? 0) - (order.get(y.photoId) ?? 0));
      return { postId: post.id, photos: out };
    },

    async matchPair(lost: PostInput, found: PostInput): Promise<MatchResult> {
      const reason = exclusionReason(lost, found, cfg);
      if (reason) return excludedResult(lost, found, reason);
      const l = evaluateLocal(lost, found);
      if (!l.bothHavePhotos) return finalize(l, 'NOT_APPLICABLE');
      if (l.pre < cfg.preScoreMin) return finalize(l, 'SKIPPED_LOW');
      if (!aiEligible(l)) return finalize(l, 'UNAVAILABLE');
      const { outcome, out } = await runCompare(l);
      return finalize(l, outcome, out);
    },

    async rankCandidates(post: PostInput, candidates: PostInput[], opts2: RankOptions = {}): Promise<RankedMatch[]> {
      const topN = Math.max(1, Math.floor(opts2.topN ?? cfg.topN));
      type Item = { candidateId: string; local: Local; outcome: AiOutcome; ai?: CompareOutput };
      const items: Item[] = [];
      const results: RankedMatch[] = [];

      for (const c of candidates.slice(0, cfg.maxCandidates)) {
        const lost = post.type === 'LOST' ? post : c;
        const found = post.type === 'LOST' ? c : post;
        if (c.type === post.type) continue; // 같은 유형은 후보가 아님
        if (exclusionReason(lost, found, cfg)) continue;
        const local = evaluateLocal(lost, found);
        let outcome: AiOutcome;
        if (!local.bothHavePhotos) outcome = 'NOT_APPLICABLE';
        else if (local.pre < cfg.preScoreMin) outcome = 'SKIPPED_LOW';
        else if (!aiEligible(local)) outcome = 'UNAVAILABLE';
        else outcome = 'NOT_TOPN';
        items.push({ candidateId: c.id, local, outcome });
      }

      // 사전 점수 상위 N(비교 가능한 후보 중)에만 직접 비교
      const eligible = items
        .filter((i) => i.outcome === 'NOT_TOPN')
        .sort((a, b) => b.local.pre - a.local.pre)
        .slice(0, topN);
      await Promise.all(
        eligible.map(async (i) => {
          const r = await runCompare(i.local);
          i.outcome = r.outcome;
          i.ai = r.out;
        }),
      );

      for (const i of items) {
        results.push({ ...finalize(i.local, i.outcome, i.ai), candidateId: i.candidateId });
      }
      // 등급(AUTO>CANDIDATE>IGNORE) 우선, 같은 등급 내 점수 내림차순. AI 미검증(degraded) 후보의 낙관적 속성 점수가 검증된 후보보다 앞서지 않게 한다
      return results.sort((a, b) => GRADE_RANK[b.grade] - GRADE_RANK[a.grade] || b.score - a.score);
    },
  };
}

function textOf(p: PostInput) {
  return { title: p.title, description: p.description, tags: [...p.presetTags, ...p.customTags] };
}
