import { describe, expect, it } from 'vitest';
import { applyColorRule, colorSimilarity } from '../color.js';
import { createMatchingEngine } from '../pipeline.js';
import { composeScore, exclusionReason } from '../scoring.js';
import { createTagNormalizer } from '../tags.js';
import { loadMatchingConfig } from '../weights.js';
import { attrs, MockAi, post, withPhoto } from './fixtures.js';

const norm = createTagNormalizer();
const cfg = loadMatchingConfig({});

describe('가중치 기본값(사용자 결정: 사진 0.45 / 태그 0.30 / 위치 0.25, 합 1.0)', () => {
  it('기본값과 환경변수 변경', () => {
    expect(cfg.weights).toEqual({ photo: 0.45, location: 0.25, tag: 0.3 });
    expect(cfg.weights.photo + cfg.weights.location + cfg.weights.tag).toBeCloseTo(1, 10);
    const o = loadMatchingConfig({ MATCH_W_PHOTO: '0.5', MATCH_W_LOCATION: '0.2', MATCH_W_TAG: '0.3' });
    expect(o.weights).toEqual({ photo: 0.5, location: 0.2, tag: 0.3 });
  });
  it('색상 안전장치 기본값: MATCH_COLOR_AUTO_MIN_AI=0.5(사용자 승인, 켬), 위치·태그 최소 점수는 꺼짐', () => {
    expect(cfg.color).toEqual({ floor: 0.7, minSim: 0.5, minConfidence: 0.5, mismatchFactor: 1, autoMinAi: 0.5 });
    expect(cfg.autoMin).toEqual({ location: 0, tag: 0 });
    expect(loadMatchingConfig({ MATCH_COLOR_AUTO_MIN_AI: '0' }).color.autoMinAi).toBe(0);
    expect(loadMatchingConfig({ MATCH_COLOR_AUTO_MIN_AI: '9' }).color.autoMinAi).toBe(0.5); // 범위 밖은 기본값
  });
  it('사진 없음 가중치(0.5/0.5)와 임계값(0.80/0.85/0.60)은 그대로', () => {
    expect(cfg.noPhotoWeights).toEqual({ location: 0.5, tag: 0.5 });
    expect([cfg.autoThreshold, cfg.autoThresholdNoPhoto, cfg.candidateThreshold]).toEqual([0.8, 0.85, 0.6]);
  });
  it('합산 예: photo 1, loc 0.8, tag 0.5 → 0.45+0.2+0.15 = 0.80', () => {
    expect(composeScore({ photo: 1, location: 0.8, tag: 0.5 }, cfg)).toBe(0.8);
  });
});

describe('색상 유사도(colorSimilarity)', () => {
  const s = (a: string[], b: string[]) => colorSimilarity(a, b, norm);
  it('같은 색은 1(동의어·표기 변형 포함)', () => {
    expect(s(['흰색'], ['화이트'])).toBe(1);
    expect(s(['검은색'], ['Black'])).toBe(1);
    expect(s(['검정'], ['블랙', '회색'])).toBe(1);
  });
  it('다중 색: 작은 쪽 색이 모두 상대에 있으면 1 ([흰색] vs [흰색,회색])', () => {
    expect(s(['흰색'], ['흰색', '회색'])).toBe(1);
    expect(s(['흰색', '회색'], ['흰색'])).toBe(1);
    expect(s(['흰색', '회색'], ['흰색', '회색'])).toBe(1);
  });
  it('인접 색(흰색↔회색, 검정↔회색)은 부분 점수 0.5, 정반대(검정↔흰색)·무관은 0', () => {
    expect(s(['흰색'], ['회색'])).toBe(0.5);
    expect(s(['검정'], ['회색'])).toBe(0.5);
    expect(s(['검정'], ['흰색'])).toBe(0);
    expect(s(['빨간색'], ['파란색'])).toBe(0);
  });
  it('색 정보가 없으면 null(판단 불가)', () => {
    expect(s([], ['흰색'])).toBeNull();
    expect(s(['흰색'], [])).toBeNull();
    expect(s(['  '], ['흰색'])).toBeNull();
  });
  it('모르는 색 이름은 같은 표기끼리만 일치', () => {
    expect(s(['무지개'], ['무지개'])).toBe(1);
    expect(s(['무지개'], ['검정'])).toBe(0);
  });
});

describe('색상 규칙(applyColorRule)', () => {
  const white = attrs({ colors: ['흰색'], category: 'earphones', brand: 'unknown', confidence: 0.85 });
  const whiteGray = attrs({ colors: ['흰색', '회색'], category: 'other', brand: 'unknown', confidence: 0.85 });
  const run = (photo: number, a: typeof white | null, b: typeof white | null, c = cfg) => applyColorRule(photo, a, b, c, norm);

  it('색이 같으면 사진 점수의 하한을 올린다(기본 0.70), 이미 높으면 그대로', () => {
    expect(run(0.15, white, whiteGray)).toMatchObject({ photo: 0.7, rule: 'FLOOR', colorSimilarity: 1 });
    expect(run(0.9, white, whiteGray)).toMatchObject({ photo: 0.9, rule: 'NONE' });
  });
  it('색이 명확히 다르면(검정 vs 흰색) 가점 없음: 점수 유지(기본 계수 1.0)', () => {
    const black = attrs({ colors: ['검정'] });
    expect(run(0.15, black, white)).toMatchObject({ photo: 0.15, rule: 'MISMATCH', colorSimilarity: 0 });
    expect(run(0.6, black, white).photo).toBe(0.6);
  });
  it('불일치 감점 계수를 설정하면 점수를 낮춘다(옵션)', () => {
    const c = loadMatchingConfig({ MATCH_COLOR_MISMATCH_FACTOR: '0.5' });
    expect(run(0.6, attrs({ colors: ['검정'] }), white, c).photo).toBeCloseTo(0.3, 10);
  });
  it('인접 색은 하한을 절반(0.35)만 적용, 최소 유사도(0.5) 미만은 적용 안 함', () => {
    expect(run(0.1, attrs({ colors: ['흰색'] }), attrs({ colors: ['회색'] })).photo).toBeCloseTo(0.35, 10);
    const strict = loadMatchingConfig({ MATCH_COLOR_MIN_SIM: '0.8' });
    expect(run(0.1, attrs({ colors: ['흰색'] }), attrs({ colors: ['회색'] }), strict)).toMatchObject({ photo: 0.1, rule: 'NONE' });
  });
  it('[가드] 카테고리 충돌(지갑 vs 이어폰, 둘 다 other 아님)이면 하한을 적용하지 않는다. other 는 충돌이 아님', () => {
    expect(run(0.1, attrs({ colors: ['검정'], category: 'wallet' }), attrs({ colors: ['검정'], category: 'earphones' })).rule).not.toBe('FLOOR');
    expect(run(0.1, attrs({ colors: ['검정'], category: 'wallet' }), attrs({ colors: ['검정'], category: 'other' })).rule).toBe('FLOOR');
  });
  it('[가드] 알려진 브랜드가 서로 다르면(ANKER vs BASEUS) 하한 없음, unknown 이 섞이면 적용', () => {
    expect(run(0.1, attrs({ colors: ['흰색'], brand: 'Anker' }), attrs({ colors: ['흰색'], brand: 'Baseus' })).rule).not.toBe('FLOOR');
    expect(run(0.1, attrs({ colors: ['흰색'], brand: 'Anker' }), attrs({ colors: ['흰색'], brand: 'unknown' })).rule).toBe('FLOOR');
  });
  it('[가드] 속성 신뢰도가 낮으면(<0.5) 적용 안 함, 속성/색 정보가 없어도 적용 안 함', () => {
    expect(run(0.1, attrs({ colors: ['흰색'], confidence: 0.3 }), white).rule).toBe('NONE');
    expect(run(0.1, null, white).rule).toBe('NONE');
    expect(run(0.1, attrs({ colors: [] }), white).rule).toBe('NONE');
  });
  it('하한 0 으로 끄면 규칙 전체가 꺼진다(MATCH_COLOR_FLOOR=0)', () => {
    const off = loadMatchingConfig({ MATCH_COLOR_FLOOR: '0' });
    expect(run(0.15, white, whiteGray, off)).toMatchObject({ photo: 0.15, rule: 'NONE' });
  });
  it('설정 범위 밖 값은 기본값으로(안전한 기본)', () => {
    const bad = loadMatchingConfig({ MATCH_COLOR_FLOOR: '5', MATCH_COLOR_MIN_SIM: '-1' });
    expect(bad.color.floor).toBe(0.7);
    expect(bad.color.minSim).toBe(0.5);
  });
  it('하한은 설정값을 넘지 않는다(AI 점수를 올리는 상한 보장)', () => {
    const c = loadMatchingConfig({ MATCH_COLOR_FLOOR: '0.6' });
    expect(run(0.0, white, white, c).photo).toBeLessThanOrEqual(0.6);
  });
});

// 실제 사례(글 14·15): 사진 점수 0.15(AI 오인식) + 위치 0.352 + 태그 0.667
const L1 = { id: '1', buildingId: 'student-hall', buildingName: '학생회관', floor: 1, groupId: 'center', lat: 36.9701, lng: 127.9301 };
const L11 = { id: '11', buildingId: 'humanities', buildingName: '인문관(더미)', floor: 1, groupId: 'east', lat: 36.9693, lng: 127.9322 };
const airpodsLost = () => post({ id: '14', type: 'LOST', authorId: 'a', title: '흰색 에어팟 잃어버림', presetTags: ['earphones'], customTags: ['에어팟', '흰색'], location: L1, photos: [withPhoto('p14', attrs({ category: 'earphones', colors: ['흰색'], confidence: 0.85 }))] });
const airpodsFound = () => post({ id: '15', type: 'FOUND', authorId: 'b', title: '흰색 에어팟 주웠음', presetTags: ['earphones'], customTags: ['에어팟'], location: L11, photos: [withPhoto('p15', attrs({ category: 'other', colors: ['흰색', '회색'], confidence: 0.85 }))] });

describe('엔진 통합 — 색상 규칙', () => {
  it('AirPods 사례: AI 가 0.15(오인식)를 줘도 색이 같으면 사진 점수 0.70 → 총점 ≥ 0.60(후보), AUTO 는 아님', async () => {
    const ai = new MockAi();
    ai.likelihood = 0.15;
    ai.compareResult = { matchingFeatures: ['흰색 외관'], conflictingFeatures: ['마우스처럼 보임'] };
    const r = await createMatchingEngine({ client: ai, config: cfg }).matchPair(airpodsLost(), airpodsFound());
    expect(r.breakdown.photoRaw).toBe(0.15);
    expect(r.breakdown.photo).toBe(0.7);
    expect(r.breakdown.colorSimilarity).toBe(1);
    expect(r.colorRule).toBe('FLOOR');
    // 0.45*0.70 + 0.25*0.352 + 0.3*0.667 ≈ 0.603
    expect(r.score).toBeCloseTo(0.603, 2);
    expect(r.grade).toBe('CANDIDATE'); // 안전장치(기본 켬)와 무관하게 후보: AUTO 가 아니므로
  });
  it('색이 정반대(검정 vs 흰색)이면 AI 점수 그대로(가점 없음) → 무시', async () => {
    const ai = new MockAi();
    ai.likelihood = 0.15;
    const lost = post({ id: 'L', type: 'LOST', authorId: 'a', location: L1, photos: [withPhoto('p1', attrs({ colors: ['검정'] }))] });
    const found = post({ id: 'F', type: 'FOUND', authorId: 'b', location: L11, photos: [withPhoto('p2', attrs({ colors: ['흰색'] }))] });
    const r = await createMatchingEngine({ client: ai, config: cfg }).matchPair(lost, found);
    expect(r.breakdown.photo).toBe(0.15);
    expect(r.colorRule).toBe('MISMATCH');
    expect(r.grade).not.toBe('AUTO');
  });
  it('[가드] 카테고리 충돌 제외는 색이 같아도 그대로(CATEGORY_CONFLICT)', () => {
    const a = post({ id: 'L', type: 'LOST', authorId: 'a', presetTags: ['wallet'] });
    const b = post({ id: 'F', type: 'FOUND', authorId: 'b', presetTags: ['earphones'] });
    expect(exclusionReason(a, b, cfg)).toBe('CATEGORY_CONFLICT');
  });
  it('[가드] AI 단계가 건너뛰어져도(degraded) 색 하한으로 AUTO 가 되지 않는다', async () => {
    const lost = post({ id: 'L', type: 'LOST', authorId: 'a', presetTags: ['earphones'], customTags: ['검정'], photos: [withPhoto('p1', attrs({ colors: ['검정'] }))] });
    const found = post({ id: 'F', type: 'FOUND', authorId: 'b', presetTags: ['earphones'], customTags: ['검정'], photos: [withPhoto('p2', attrs({ colors: ['검정'] }))] });
    const r = await createMatchingEngine({ client: null, config: cfg }).matchPair(lost, found);
    expect(r.degraded).toBe(true);
    expect(r.grade).not.toBe('AUTO');
  });
  it('[가드] 인젝션: AI 가 근거 없이 1.0 을 줘도 상한 0.6 이 유지되고 색 규칙은 그 아래로만 작동(하한이므로 더 낮추지 않음)', async () => {
    const ai = new MockAi();
    ai.likelihood = 1;
    ai.compareResult = { matchingFeatures: [], conflictingFeatures: [] };
    const lost = post({ id: 'L', type: 'LOST', authorId: 'a', location: L1, photos: [withPhoto('p1', attrs({ colors: ['흰색'] }))] });
    const found = post({ id: 'F', type: 'FOUND', authorId: 'b', location: L1, photos: [withPhoto('p2', attrs({ colors: ['흰색'] }))] });
    const r = await createMatchingEngine({ client: ai, config: cfg }).matchPair(lost, found);
    expect(r.breakdown.photoRaw).toBe(0.6); // 근거 없는 고점수 상한
    expect(r.breakdown.photo).toBe(0.7); // 색 하한(속성 기반, 기본 0.70)이 더 높으면 하한이 적용된다 — 아래 완화 옵션으로 제어
  });
  it('[기본 켬] 색 하한(0.70)만으로 올라간 쌍은 AI 원점수가 0.5 미만이면 위치·태그가 만점이어도 AUTO 가 아니라 CANDIDATE (총점 0.865)', async () => {
    const ai = new MockAi();
    ai.likelihood = 0.3;
    const lost = post({ id: 'L', type: 'LOST', authorId: 'a', presetTags: ['earphones'], customTags: ['검정'], location: L1, photos: [withPhoto('p1', attrs({ colors: ['검정'] }))] });
    const found = post({ id: 'F', type: 'FOUND', authorId: 'b', presetTags: ['earphones'], customTags: ['검정'], location: L1, photos: [withPhoto('p2', attrs({ colors: ['검정'] }))] });
    const r = await createMatchingEngine({ client: ai, config: cfg }).matchPair(lost, found);
    expect(r.breakdown.photoRaw).toBe(0.3);
    expect(r.breakdown.photo).toBe(0.7);
    expect(r.score).toBeCloseTo(0.865, 2); // 점수는 그대로, 등급만 낮춘다
    expect(r.colorRule).toBe('FLOOR');
    expect(r.grade).toBe('CANDIDATE');
  });
  it('[기본 켬] AI 원점수가 0.5 이상이면(색 하한이 올려도) AUTO 허용, 0.5 미만은 후보', async () => {
    const ai = new MockAi();
    const lost = post({ id: 'L', type: 'LOST', authorId: 'a', presetTags: ['earphones'], customTags: ['검정'], location: L1, photos: [withPhoto('p1', attrs({ colors: ['검정'] }))] });
    const found = post({ id: 'F', type: 'FOUND', authorId: 'b', presetTags: ['earphones'], customTags: ['검정'], location: L1, photos: [withPhoto('p2', attrs({ colors: ['검정'] }))] });
    ai.likelihood = 0.6;
    expect((await createMatchingEngine({ client: ai, config: cfg }).matchPair(lost, found)).grade).toBe('AUTO');
    ai.likelihood = 0.49;
    expect((await createMatchingEngine({ client: ai, config: cfg }).matchPair(lost, found)).grade).toBe('CANDIDATE');
  });
  it('[기본 켬] AI 가 이미 높게 준 쌍(색 하한이 필요 없음)은 영향 없음', async () => {
    const ai = new MockAi();
    ai.likelihood = 0.9;
    const lost = post({ id: 'L', type: 'LOST', authorId: 'a', presetTags: ['earphones'], customTags: ['검정'], location: L1, photos: [withPhoto('p1', attrs({ colors: ['검정'] }))] });
    const found = post({ id: 'F', type: 'FOUND', authorId: 'b', presetTags: ['earphones'], customTags: ['검정'], location: L1, photos: [withPhoto('p2', attrs({ colors: ['검정'] }))] });
    const r = await createMatchingEngine({ client: ai, config: cfg }).matchPair(lost, found);
    expect(r.colorRule).toBe('NONE');
    expect(r.grade).toBe('AUTO');
  });
  it('[끄면] MATCH_COLOR_AUTO_MIN_AI=0 이면 색 하한만으로 AUTO 가 될 수 있다(부작용 재현용)', async () => {
    const ai = new MockAi();
    ai.likelihood = 0.3;
    const lost = post({ id: 'L', type: 'LOST', authorId: 'a', presetTags: ['earphones'], customTags: ['검정'], location: L1, photos: [withPhoto('p1', attrs({ colors: ['검정'] }))] });
    const found = post({ id: 'F', type: 'FOUND', authorId: 'b', presetTags: ['earphones'], customTags: ['검정'], location: L1, photos: [withPhoto('p2', attrs({ colors: ['검정'] }))] });
    const off = loadMatchingConfig({ MATCH_COLOR_AUTO_MIN_AI: '0' });
    expect((await createMatchingEngine({ client: ai, config: off }).matchPair(lost, found)).grade).toBe('AUTO');
  });
  it('[완화 옵션] MATCH_AUTO_MIN_LOCATION / MATCH_AUTO_MIN_TAG: 사진이 좋아도 위치·태그 최소 점수가 없으면 AUTO 를 막는다(기본 꺼짐)', async () => {
    const ai = new MockAi();
    ai.likelihood = 1;
    const lost = post({ id: 'L', type: 'LOST', authorId: 'a', presetTags: ['earphones'], customTags: ['검정'], location: L1, photos: [withPhoto('p1', attrs({ colors: ['검정'] }))] });
    const found = post({ id: 'F', type: 'FOUND', authorId: 'b', presetTags: ['earphones'], customTags: ['검정'], location: L11, photos: [withPhoto('p2', attrs({ colors: ['검정'] }))] });
    const base = await createMatchingEngine({ client: ai, config: cfg }).matchPair(lost, found);
    expect(base.breakdown.location).toBeCloseTo(0.352, 2);
    expect(base.grade).toBe('AUTO'); // 다른 건물이어도 사진이 확실하면 AUTO
    const g = await createMatchingEngine({ client: ai, config: loadMatchingConfig({ MATCH_AUTO_MIN_LOCATION: '0.5' }) }).matchPair(lost, found);
    expect(g.grade).toBe('CANDIDATE');
    const sameLoc = { ...found, location: L1, customTags: ['검정', '우산'] };
    const noTag = { ...lost, customTags: ['검정', '흰색'] };
    const base2 = await createMatchingEngine({ client: ai, config: cfg }).matchPair(noTag, sameLoc);
    expect(base2.breakdown.tag).toBeLessThan(0.8);
    expect(base2.grade).toBe('AUTO');
    const gt = await createMatchingEngine({ client: ai, config: loadMatchingConfig({ MATCH_AUTO_MIN_TAG: '0.8' }) }).matchPair(noTag, sameLoc);
    expect(gt.grade).toBe('CANDIDATE');
  });
  it('색 하한을 끄면(MATCH_COLOR_FLOOR=0) AI 점수 그대로', async () => {
    const ai = new MockAi();
    ai.likelihood = 0.15;
    const r = await createMatchingEngine({ client: ai, config: loadMatchingConfig({ MATCH_COLOR_FLOOR: '0' }) }).matchPair(airpodsLost(), airpodsFound());
    expect(r.breakdown.photo).toBe(0.15);
    expect(r.grade).toBe('IGNORE');
  });
  it('사진 없음(NO_PHOTO)은 색 규칙과 무관: 점수·가중치 그대로', async () => {
    const lost = post({ id: 'L', type: 'LOST', authorId: 'a', location: L1 });
    const found = post({ id: 'F', type: 'FOUND', authorId: 'b', location: L1 });
    const r = await createMatchingEngine({ config: cfg }).matchPair(lost, found);
    expect(r.mode).toBe('NO_PHOTO');
    expect(r.colorRule).toBeUndefined();
  });
});
