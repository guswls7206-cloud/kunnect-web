import { describe, expect, it } from 'vitest';
import { AiError } from '../claude.js';
import { createMatchingEngine } from '../pipeline.js';
import { loadMatchingConfig } from '../weights.js';
import { attrs, LOC_FAR, LOC_LIB, LOC_UNION_2F, MockAi, post, withPhoto } from './fixtures.js';

const cfg = loadMatchingConfig({});
const lostNoPhoto = post({ id: 'L', type: 'LOST', authorId: 'u1' });
const foundNoPhoto = post({ id: 'F', type: 'FOUND', authorId: 'u2', location: LOC_UNION_2F });

describe('사진 없음 경로(NO_PHOTO)', () => {
  it('README 예시: 학생회관 분실 ↔ 학생회관 2층 습득 → 0.9로 AUTO(임계 0.85)', async () => {
    const r = await createMatchingEngine({ config: cfg }).matchPair(lostNoPhoto, foundNoPhoto);
    expect(r.mode).toBe('NO_PHOTO');
    expect(r.breakdown.photo).toBeUndefined();
    expect(r.score).toBe(0.9);
    expect(r.autoThreshold).toBe(0.85);
    expect(r.grade).toBe('AUTO');
    expect(r.degraded).toBe(false);
  });
  it('0.80~0.85 구간은 AUTO가 아니라 CANDIDATE', async () => {
    // 위치 0.65(그룹) + 태그 1.0 → 0.825
    const r = await createMatchingEngine({ config: cfg }).matchPair(lostNoPhoto, { ...foundNoPhoto, location: LOC_LIB });
    expect(r.score).toBe(0.825);
    expect(r.grade).toBe('CANDIDATE');
  });
  it('위치 불일치·태그 일부만 겹치면 IGNORE', async () => {
    const f = { ...foundNoPhoto, location: LOC_FAR, customTags: ['흰색'] };
    const r = await createMatchingEngine({ config: cfg }).matchPair(lostNoPhoto, f);
    expect(r.grade).toBe('IGNORE');
  });
  it('제외 규칙에 걸리면 excluded + IGNORE + AI 미호출', async () => {
    const ai = new MockAi();
    const f = { ...foundNoPhoto, presetTags: ['wallet'] };
    const r = await createMatchingEngine({ client: ai, config: cfg }).matchPair(lostNoPhoto, f);
    expect(r.excluded).toBe('CATEGORY_CONFLICT');
    expect(r.grade).toBe('IGNORE');
    expect(r.score).toBe(0);
    expect(ai.compareCalls).toBe(0);
  });
  it('양쪽 모두 사진이 없으면 AI를 호출하지 않는다', async () => {
    const ai = new MockAi();
    await createMatchingEngine({ client: ai, config: cfg }).matchPair(lostNoPhoto, foundNoPhoto);
    expect(ai.compareCalls).toBe(0);
  });
});

describe('사진 있음 경로(WITH_PHOTO)', () => {
  const lost = { ...lostNoPhoto, photos: [withPhoto('p1', attrs())] };
  const found = { ...foundNoPhoto, photos: [withPhoto('p2', attrs())] };

  it('Claude 비교 점수를 photo로 사용: 0.45*0.9+0.25*0.8+0.3*1 = 0.905 → AUTO(0.80)', async () => {
    const ai = new MockAi();
    ai.likelihood = 0.9;
    const r = await createMatchingEngine({ client: ai, config: cfg }).matchPair(lost, found);
    expect(r.mode).toBe('WITH_PHOTO');
    expect(r.photoSource).toBe('AI_COMPARE');
    expect(r.breakdown.photo).toBe(0.9);
    expect(r.score).toBe(0.905);
    expect(r.grade).toBe('AUTO');
    expect(r.aiReason).toBe('색과 형태가 비슷합니다');
    expect(r.autoThreshold).toBe(0.8);
    expect(ai.compareCalls).toBe(1);
  });
  it('AI가 낮게 평가하고 색도 다르면 같은 위치·태그여도 AUTO가 되지 않는다', async () => {
    const ai = new MockAi();
    ai.likelihood = 0.2; // 0.09 + 0.2 + 0.3 = 0.59 (색이 정반대라 하한 가점 없음)
    const diffColor = { ...found, photos: [withPhoto('p2', attrs({ colors: ['흰색'] }))] };
    const r = await createMatchingEngine({ client: ai, config: cfg }).matchPair(lost, diffColor);
    expect(r.grade).toBe('IGNORE');
    expect(r.colorRule).toBe('MISMATCH');
  });
  it('AI 가 낮게 평가해도 색이 같으면 색 하한(0.70)이 적용된다(사용자 결정): 0.315 + 0.2 + 0.3 = 0.815', async () => {
    const ai = new MockAi();
    ai.likelihood = 0.2;
    const r = await createMatchingEngine({ client: ai, config: cfg }).matchPair(lost, found);
    expect(r.breakdown.photo).toBe(0.7);
    expect(r.breakdown.photoRaw).toBe(0.2);
    expect(r.colorRule).toBe('FLOOR');
    expect(r.score).toBe(0.815);
  });
  it('경계: 점수가 정확히 0.80이면 AUTO', async () => {
    const ai = new MockAi();
    ai.likelihood = 2 / 3; // 0.3 + 0.2 + 0.3 = 0.8 (색이 다르면 하한 가점 없음)
    const diffColor = { ...found, photos: [withPhoto('p2', attrs({ colors: ['흰색'] }))] };
    const r = await createMatchingEngine({ client: ai, config: cfg }).matchPair(lost, diffColor);
    expect(r.score).toBe(0.8);
    expect(r.grade).toBe('AUTO');
  });
  it('AI 호출 실패 → 속성 점수로 대체하고 degraded, AUTO는 CANDIDATE로 강등', async () => {
    const ai = new MockAi();
    ai.failCompare = new AiError('UNAVAILABLE', 'x');
    const r = await createMatchingEngine({ client: ai, config: cfg }).matchPair(lost, found);
    expect(r.degraded).toBe(true);
    expect(r.photoSource).toBe('ATTRIBUTES');
    expect(r.grade).toBe('CANDIDATE');
  });
  it('예기치 못한 예외도 throw하지 않고 degraded 처리', async () => {
    const ai = new MockAi();
    ai.failCompare = new TypeError('boom');
    const r = await createMatchingEngine({ client: ai, config: cfg }).matchPair(lost, found);
    expect(r.degraded).toBe(true);
  });
  it('클라이언트 없음(키 미설정) → degraded, 알림 승격 없음', async () => {
    const r = await createMatchingEngine({ client: null, config: cfg }).matchPair(lost, found);
    expect(r.degraded).toBe(true);
    expect(r.grade).not.toBe('AUTO');
  });
  it('사전 점수가 낮으면 AI 호출을 생략(비용 절감)하고 degraded 아님', async () => {
    const ai = new MockAi();
    const l2 = { ...lost, presetTags: [] };
    const f2 = {
      ...found,
      presetTags: [],
      location: LOC_FAR,
      customTags: ['흰색'],
      photos: [withPhoto('p3', attrs({ category: 'wallet', colors: ['흰색'], brand: 'X' }))],
    };
    const r = await createMatchingEngine({ client: ai, config: cfg }).matchPair(l2, f2);
    expect(ai.compareCalls).toBe(0);
    expect(r.degraded).toBe(false);
    expect(r.grade).toBe('IGNORE');
  });
  it('이미지 데이터 없이 속성만 있으면 비교 불가 → degraded', async () => {
    const ai = new MockAi();
    const l = { ...lost, photos: [{ id: 'p1', attributes: attrs() }] };
    const f = { ...found, photos: [{ id: 'p2', attributes: attrs() }] };
    const r = await createMatchingEngine({ client: ai, config: cfg }).matchPair(l, f);
    expect(ai.compareCalls).toBe(0);
    expect(r.degraded).toBe(true);
  });
  it('한쪽만 사진: 사진 신호 제외, 태그 점수만 최대 +0.1 보정, degraded 아님', async () => {
    const ai = new MockAi();
    const l = { ...lostNoPhoto, customTags: [], presetTags: ['earphones'], photos: [withPhoto('p1', attrs({ colors: ['검정'] }))] };
    const f = { ...foundNoPhoto, customTags: ['검정'], presetTags: ['earphones'] };
    const r = await createMatchingEngine({ client: ai, config: cfg }).matchPair(l, f);
    expect(r.mode).toBe('NO_PHOTO');
    expect(r.degraded).toBe(false);
    expect(ai.compareCalls).toBe(0);
    // 기본 태그 Jaccard 1/2 = 0.5, 보정 +0.1 × 신뢰도(0.9) = +0.09
    expect(r.breakdown.tag).toBeCloseTo(0.59, 5);
  });
});

describe('rankCandidates', () => {
  const lost = { ...lostNoPhoto, photos: [withPhoto('p0', attrs())] };
  const mk = (i: number, over = {}) =>
    post({ id: `F${i}`, type: 'FOUND', authorId: `u${i + 10}`, location: LOC_UNION_2F, photos: [withPhoto(`pf${i}`, attrs())], ...over });

  it('상위 N(기본 5)에만 Claude 비교, 나머지는 degraded로 AUTO 불가', async () => {
    const ai = new MockAi();
    const cands = Array.from({ length: 8 }, (_, i) => mk(i));
    const res = await createMatchingEngine({ client: ai, config: cfg }).rankCandidates(lost, cands);
    expect(ai.compareCalls).toBe(5);
    expect(res).toHaveLength(8);
    expect(res.filter((r) => r.photoSource === 'AI_COMPARE')).toHaveLength(5);
    expect(res.filter((r) => r.degraded)).toHaveLength(3);
    expect(res.every((r) => (r.degraded ? r.grade !== 'AUTO' : true))).toBe(true);
  });
  it('topN 옵션과 등급·점수 정렬(미검증 후보가 검증 후보를 앞서지 않음)', async () => {
    const ai = new MockAi();
    const cands = [mk(1, { location: LOC_FAR }), mk(2), mk(3, { location: LOC_LIB })];
    const res = await createMatchingEngine({ client: ai, config: cfg }).rankCandidates(lost, cands, { topN: 1 });
    expect(ai.compareCalls).toBe(1);
    const rank = { AUTO: 2, CANDIDATE: 1, IGNORE: 0 };
    for (let i = 1; i < res.length; i++) {
      const a = res[i - 1]!, b = res[i]!;
      expect(rank[a.grade] > rank[b.grade] || (a.grade === b.grade && a.score >= b.score)).toBe(true);
    }
    expect(res[0]?.degraded).toBe(false); // AI 검증된 후보가 미검증 후보보다 앞
    expect(res[0]?.candidateId).toBe('F2');
  });
  it('제외 후보와 같은 유형 후보는 결과에서 빠진다', async () => {
    const ai = new MockAi();
    const res = await createMatchingEngine({ client: ai, config: cfg }).rankCandidates(lost, [
      mk(1, { presetTags: ['wallet'] }),
      post({ id: 'LOST2', type: 'LOST', authorId: 'u99' }),
      mk(2),
    ]);
    expect(res.map((r) => r.candidateId)).toEqual(['F2']);
  });
  it('FOUND 글을 기준으로 LOST 후보를 평가해도 lost/found가 올바르게 매겨진다', async () => {
    const found = mk(1);
    const res = await createMatchingEngine({ client: new MockAi(), config: cfg }).rankCandidates(found, [lost]);
    expect(res[0]?.lostPostId).toBe('L');
    expect(res[0]?.foundPostId).toBe('F1');
  });
  it('후보 풀 상한(maxCandidates) 초과분은 무시', async () => {
    const small = { ...cfg, maxCandidates: 2 };
    const res = await createMatchingEngine({ client: new MockAi(), config: small }).rankCandidates(
      lostNoPhoto,
      [1, 2, 3, 4].map((i) => post({ id: `F${i}`, type: 'FOUND', authorId: `u${i + 10}` })),
    );
    expect(res).toHaveLength(2);
  });
  it('후보 빈 배열', async () => {
    expect(await createMatchingEngine({ config: cfg }).rankCandidates(lost, [])).toEqual([]);
  });
});

describe('extractAttributes', () => {
  it('캐시된 속성은 재호출하지 않고, 없는 사진만 1회 호출로 묶어 처리', async () => {
    const ai = new MockAi();
    const p = post({ id: 'P', type: 'LOST', photos: [withPhoto('a', attrs()), withPhoto('b'), withPhoto('c')] });
    const r = await createMatchingEngine({ client: ai, config: cfg }).extractAttributes(p);
    expect(ai.extractCalls).toBe(1);
    expect(r.photos.map((x) => [x.photoId, x.status])).toEqual([['a', 'OK'], ['b', 'OK'], ['c', 'OK']]);
  });
  it('모두 캐시되어 있으면 호출 없음', async () => {
    const ai = new MockAi();
    const p = post({ id: 'P', type: 'LOST', photos: [withPhoto('a', attrs())] });
    await createMatchingEngine({ client: ai, config: cfg }).extractAttributes(p);
    expect(ai.extractCalls).toBe(0);
  });
  it('실패 시 throw 없이 FAILED(사유 코드만)', async () => {
    const ai = new MockAi();
    ai.failExtract = new AiError('REFUSAL', 'secret detail');
    const p = post({ id: 'P', type: 'LOST', photos: [withPhoto('a')] });
    const r = await createMatchingEngine({ client: ai, config: cfg }).extractAttributes(p);
    expect(r.photos[0]).toMatchObject({ status: 'FAILED', reason: 'REFUSAL', attributes: null });
  });
  it('클라이언트 없으면 SKIPPED, 이미지 데이터 없으면 SKIPPED', async () => {
    const p = post({ id: 'P', type: 'LOST', photos: [withPhoto('a'), { id: 'b' }] });
    const r = await createMatchingEngine({ client: null, config: cfg }).extractAttributes(p);
    expect(r.photos.map((x) => x.status)).toEqual(['SKIPPED', 'SKIPPED']);
  });
  it('사진이 없으면 빈 결과', async () => {
    const r = await createMatchingEngine({ client: new MockAi(), config: cfg }).extractAttributes(post({ id: 'P', type: 'LOST' }));
    expect(r.photos).toEqual([]);
  });
});
