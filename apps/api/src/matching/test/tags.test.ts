import { describe, expect, it } from 'vitest';
import { baseNormalize, createTagNormalizer, DEFAULT_IMPLIED, DEFAULT_SYNONYMS, SYNONYM_GROUPS, tagSet, tagSimilarity } from '../tags.js';
import { createMatchingEngine } from '../pipeline.js';
import { loadMatchingConfig } from '../weights.js';
import { LOC_UNION_2F, post } from './fixtures.js';

const norm = createTagNormalizer();
const sim = (a: string[], b: string[]) => tagSimilarity({ preset: [], custom: a }, { preset: [], custom: b }, norm);

describe('동의어 사전 무결성', () => {
  it('같은 표기가 서로 다른 그룹에 중복 정의되지 않는다(조용한 덮어쓰기 방지)', () => {
    const seen = new Map<string, string>();
    const dups: string[] = [];
    for (const g of SYNONYM_GROUPS) {
      for (const v of [g.canonical, ...g.variants]) {
        const k = baseNormalize(v);
        const prev = seen.get(k);
        if (prev !== undefined && prev !== g.canonical) dups.push(`${k}: ${prev} vs ${g.canonical}`);
        seen.set(k, g.canonical);
      }
    }
    expect(dups).toEqual([]);
  });
  it('한 글자 표기는 넣지 않는다(자유 텍스트 오탐 방지)', () => {
    const singles = Object.keys(DEFAULT_SYNONYMS).filter((k) => [...k].length === 1);
    expect(singles).toEqual([]);
  });
  it('implied 값은 모두 대표 토큰이거나 프리셋 슬러그', () => {
    const presets = new Set(['earphones', 'smartphone', 'studentid', 'wallet', 'bag', 'keys', 'laptop']);
    for (const up of Object.values(DEFAULT_IMPLIED)) expect(presets.has(up)).toBe(true);
  });
  it("프로토타입 키('constructor')가 태그로 들어와도 안전", () => {
    expect(tagSet([], ['constructor', '__proto__', 'toString'], norm).size).toBe(3);
  });
});

describe('캠퍼스 분실물 동의어', () => {
  it.each([
    ['이어폰', 'earphones'],
    ['무선 이어폰', 'earphones'],
    ['Earbuds', 'earphones'],
    ['핸드폰', 'smartphone'],
    ['휴대폰', 'smartphone'],
    ['학생증', 'student_id'],
    ['신분증', 'student_id'],
    ['지갑', 'wallet'],
    ['카드지갑', 'wallet'],
    ['백팩', 'bag'],
    ['열쇠', 'keys'],
    ['랩탑', 'laptop'],
  ])('%s ≡ 프리셋 %s', (word, slug) => {
    expect(norm(word)).toBe(norm(slug));
  });
  it.each([
    ['보조 배터리', '파워뱅크'],
    ['우산', '장우산'],
    ['텀블러', 'tumbler'],
    ['충전기', '어댑터'],
    ['아이패드', 'iPad'],
    ['스마트워치', '애플워치'],
    ['검은색', 'Black'],
    ['네이비', '남색'],
    ['핑크', '분홍'],
  ])('%s ≡ %s', (a, b) => expect(norm(a)).toBe(norm(b)));

  it('서로 다른 물건은 같은 토큰이 되지 않는다', () => {
    expect(norm('우산')).not.toBe(norm('텀블러'));
    expect(norm('지갑')).not.toBe(norm('가방'));
    expect(norm('보조배터리')).not.toBe(norm('충전기'));
  });
  it('한 글자 일반어는 변환되지 않는다(예: "은")', () => {
    expect(norm('은')).toBe('은');
    expect(norm('금')).toBe('금');
  });
});

describe('브랜드 → 상위 카테고리 부분 일치', () => {
  it('에어팟 ↔ 이어폰: 상위 카테고리가 겹쳐 0.5', () => {
    // {에어팟, earphones} vs {earphones} → 교집합 1 / 합집합 2
    expect(sim(['에어팟'], ['이어폰'])).toBeCloseTo(0.5, 5);
  });
  it('에어팟 ↔ 버즈: 카테고리만 겹쳐 1/3 (브랜드 불일치는 부분 감점)', () => {
    expect(sim(['에어팟'], ['버즈'])).toBeCloseTo(1 / 3, 5);
  });
  it('에어팟 ↔ 에어팟 프로: 같은 모델군은 1.0', () => {
    expect(sim(['에어팟'], ['AirPods Pro'])).toBe(1);
  });
  it('에어팟 ↔ 우산: 관련 없음 0', () => {
    expect(sim(['에어팟'], ['우산'])).toBe(0);
  });
  it('프리셋 earphones + 커스텀 에어팟 vs 프리셋 earphones: 암시 토큰 덕에 1/2', () => {
    const s = tagSimilarity({ preset: ['earphones'], custom: ['에어팟'] }, { preset: ['earphones'], custom: [] }, norm);
    expect(s).toBeCloseTo(0.5, 5);
  });
});

describe('엔진 통합: 동의어가 매칭에 반영된다', () => {
  const cfg = loadMatchingConfig({});
  it('분실 "에어팟 검은색" ↔ 습득 "이어폰 블랙": 사진 없이도 후보 이상', async () => {
    const lost = post({ id: 'L', type: 'LOST', authorId: 'u1', presetTags: [], customTags: ['에어팟', '검은색'] });
    const found = post({ id: 'F', type: 'FOUND', authorId: 'u2', presetTags: [], customTags: ['이어폰', 'Black'], location: LOC_UNION_2F });
    const r = await createMatchingEngine({ config: cfg }).matchPair(lost, found);
    // 태그 {에어팟,earphones,검정} vs {earphones,검정} = 2/3, 위치 0.8 → 0.733
    expect(r.breakdown.tag).toBeCloseTo(2 / 3, 3);
    expect(r.grade).toBe('CANDIDATE');
  });
  it('분실 "우산" ↔ 습득 "텀블러": 태그 0이라 무시', async () => {
    const lost = post({ id: 'L', type: 'LOST', authorId: 'u1', presetTags: [], customTags: ['우산'] });
    const found = post({ id: 'F', type: 'FOUND', authorId: 'u2', presetTags: [], customTags: ['텀블러'] });
    const r = await createMatchingEngine({ config: cfg }).matchPair(lost, found);
    expect(r.breakdown.tag).toBe(0);
    expect(r.grade).not.toBe('AUTO');
  });
});
