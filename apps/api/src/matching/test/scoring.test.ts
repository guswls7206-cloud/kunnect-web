import { describe, expect, it } from 'vitest';
import { attributeScore, composeScore, confidenceWeight, exclusionReason, gradeFor, haversineMeters, locationScore, mergeAttributes } from '../scoring.js';
import { createTagNormalizer, jaccard, tagSimilarity } from '../tags.js';
import { loadMatchingConfig } from '../weights.js';
import { attrs, LOC_FAR, LOC_LIB, LOC_UNION_1F, LOC_UNION_2F, post } from './fixtures.js';

const cfg = loadMatchingConfig({});
const norm = createTagNormalizer();

describe('위치 점수', () => {
  it('같은 위치 ID는 1.0', () => expect(locationScore(LOC_UNION_1F, { ...LOC_UNION_1F })).toBe(1));
  it('같은 건물 다른 층은 0.8', () => expect(locationScore(LOC_UNION_1F, LOC_UNION_2F)).toBe(0.8));
  it('같은 인접 그룹은 0.65', () => expect(locationScore(LOC_UNION_1F, LOC_LIB)).toBe(0.65));
  it('그룹이 다르면 좌표 거리 감쇠, 최대 0.5', () => {
    const near = { ...LOC_FAR, groupId: 'x', lat: 37.002, lng: 127.0 }; // 약 222m
    const s = locationScore(LOC_UNION_1F, near);
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThanOrEqual(0.5);
  });
  it('500m 이상이면 0', () => expect(locationScore(LOC_UNION_1F, LOC_FAR)).toBe(0));
  it('좌표/그룹이 없고 건물이 다르면 0', () => {
    const a = { id: 'a', buildingId: 'ba', buildingName: 'A' };
    const b = { id: 'b', buildingId: 'bb', buildingName: 'B' };
    expect(locationScore(a, b)).toBe(0);
  });
  it('위치가 없으면 0', () => {
    expect(locationScore(null, LOC_UNION_1F)).toBe(0);
    expect(locationScore(LOC_UNION_1F, null)).toBe(0);
  });
  it('haversine: 위도 0.001도 ≈ 111m', () => {
    expect(haversineMeters(37, 127, 37.001, 127)).toBeGreaterThan(105);
    expect(haversineMeters(37, 127, 37.001, 127)).toBeLessThan(117);
  });
});

describe('태그 정규화·유사도', () => {
  it('공백/대소문자/# 제거, 동의어 치환', () => {
    expect(norm(' #Black ')).toBe(norm('검은색'));
    expect(norm('AirPods')).toBe(norm('에어팟'));
  });
  it('Jaccard: 동일=1, 서로소=0, 한쪽 빈 집합=0', () => {
    expect(jaccard(new Set(['a']), new Set(['a']))).toBe(1);
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0);
    expect(jaccard(new Set<string>(), new Set(['a']))).toBe(0);
  });
  it('사용자 정의 태그 동의어(검은=블랙)가 일치로 인정', () => {
    const s = tagSimilarity({ preset: ['earphones'], custom: ['블랙'] }, { preset: ['earphones'], custom: ['검은'] }, norm);
    expect(s).toBe(1);
  });
  it('태그가 전혀 없으면 0(정보 없음)', () => {
    expect(tagSimilarity({ preset: [], custom: [] }, { preset: [], custom: [] }, norm)).toBe(0);
  });
});

describe('가중 합산', () => {
  it('사진 있음: 0.45/0.25/0.30', () => {
    expect(composeScore({ photo: 1, location: 1, tag: 1 }, cfg)).toBe(1);
    expect(composeScore({ photo: 0.8, location: 0.4, tag: 0.4 }, cfg)).toBe(0.58);
  });
  it('사진 없음: 위치/태그만 0.5/0.5로 재정규화', () => {
    expect(composeScore({ location: 1, tag: 0.8 }, cfg)).toBe(0.9);
  });
  it('범위 밖 입력은 0~1로 제한', () => {
    expect(composeScore({ photo: 5, location: 5, tag: 5 }, cfg)).toBe(1);
    expect(composeScore({ photo: -1, location: -1, tag: -1 }, cfg)).toBe(0);
  });
});

describe('임계값 판정(경계값)', () => {
  it('0.80은 AUTO, 0.7999는 CANDIDATE', () => {
    expect(gradeFor(0.8, 0.8, cfg)).toBe('AUTO');
    expect(gradeFor(0.7999, 0.8, cfg)).toBe('CANDIDATE');
  });
  it('0.60은 CANDIDATE, 0.5999는 IGNORE', () => {
    expect(gradeFor(0.6, 0.8, cfg)).toBe('CANDIDATE');
    expect(gradeFor(0.5999, 0.8, cfg)).toBe('IGNORE');
  });
  it('사진 없음 임계값 0.85: 0.84는 CANDIDATE, 0.85는 AUTO', () => {
    expect(gradeFor(0.84, 0.85, cfg)).toBe('CANDIDATE');
    expect(gradeFor(0.85, 0.85, cfg)).toBe('AUTO');
  });
});

describe('제외 규칙', () => {
  const lost = post({ id: 'L', type: 'LOST', authorId: 'u1' });
  it('카테고리 태그가 서로 다르면 제외', () => {
    const found = post({ id: 'F', type: 'FOUND', authorId: 'u2', presetTags: ['wallet'] });
    expect(exclusionReason(lost, found, cfg)).toBe('CATEGORY_CONFLICT');
  });
  it('한쪽에 카테고리 태그가 없으면 제외하지 않음', () => {
    const found = post({ id: 'F', type: 'FOUND', authorId: 'u2', presetTags: [] });
    expect(exclusionReason(lost, found, cfg)).toBeNull();
  });
  it('카테고리가 여러 개여도 교집합이 있으면 충돌 아님', () => {
    const found = post({ id: 'F', type: 'FOUND', authorId: 'u2', presetTags: ['wallet', 'earphones'] });
    expect(exclusionReason(lost, found, cfg)).toBeNull();
  });
  it('같은 작성자 제외', () => {
    expect(exclusionReason(lost, post({ id: 'F', type: 'FOUND', authorId: 'u1' }), cfg)).toBe('SAME_AUTHOR');
  });
  it('습득이 분실보다 1일 넘게 앞서면 제외, 1일 이내는 허용', () => {
    const f1 = post({ id: 'F', type: 'FOUND', authorId: 'u2', occurredAt: '2026-09-30T08:00:00+09:00' });
    const f2 = post({ id: 'F', type: 'FOUND', authorId: 'u2', occurredAt: '2026-09-30T10:00:00+09:00' });
    expect(exclusionReason(lost, f1, cfg)).toBe('TIME_BEFORE_LOST');
    expect(exclusionReason(lost, f2, cfg)).toBeNull();
  });
  it('유형이 잘못 들어오면 SAME_TYPE', () => {
    expect(exclusionReason(lost, post({ id: 'X', type: 'LOST', authorId: 'u2' }), cfg)).toBe('SAME_TYPE');
  });
  it('시간 파싱 불가 시 시간 규칙은 적용하지 않음', () => {
    const f = post({ id: 'F', type: 'FOUND', authorId: 'u2', occurredAt: 'invalid' });
    expect(exclusionReason(lost, f, cfg)).toBeNull();
  });
});

describe('사진 속성', () => {
  it('알려진 브랜드끼리 다르면 감점(0.7배), unknown이 섞이면 감점 없음', () => {
    const same = attributeScore(attrs({ confidence: 1 }), attrs({ confidence: 1 }), norm);
    const diff = attributeScore(attrs({ confidence: 1, brand: 'Apple' }), attrs({ confidence: 1, brand: 'Samsung' }), norm);
    const unk = attributeScore(attrs({ confidence: 1, brand: 'Apple' }), attrs({ confidence: 1, brand: 'unknown' }), norm);
    expect(diff).toBeLessThan(same * 0.8);
    expect(unk).toBeGreaterThan(diff);
  });
  it('신뢰도가 낮으면 중립(0.5)쪽으로 수축, 하한 0.2', () => {
    const hi = attributeScore(attrs({ confidence: 1 }), attrs({ confidence: 1 }), norm); // 1
    const mid = attributeScore(attrs({ confidence: 0.5 }), attrs({ confidence: 1 }), norm); // 낮은 쪽 0.5 → 0.75
    const zero = attributeScore(attrs({ confidence: 0 }), attrs({ confidence: 1 }), norm); // 하한 0.2 → 0.6
    expect(hi).toBeCloseTo(1, 5);
    expect(mid).toBeCloseTo(0.75, 5);
    expect(zero).toBeCloseTo(0.6, 5);
    expect(confidenceWeight(attrs({ confidence: NaN }))).toBe(0.2);
  });
  it('낮은 신뢰도 불일치는 덜 감점(중립쪽 수축)', () => {
    const sure = attributeScore(attrs({ confidence: 1 }), attrs({ confidence: 1, category: 'wallet', colors: ['흰색'], brand: 'X' }), norm);
    const unsure = attributeScore(attrs({ confidence: 0.3 }), attrs({ confidence: 1, category: 'wallet', colors: ['흰색'], brand: 'X' }), norm);
    expect(unsure).toBeGreaterThan(sure);
  });
  it('동일 속성은 1에 가깝고 카테고리 불일치는 크게 낮다', () => {
    expect(attributeScore(attrs({ confidence: 1 }), attrs({ confidence: 1 }), norm)).toBeCloseTo(1, 5);
    expect(attributeScore(attrs({ confidence: 1 }), attrs({ confidence: 1, category: 'wallet' }), norm)).toBeLessThan(0.65);
  });
  it('unknown 브랜드/빈 색은 중립(0.5) 처리', () => {
    const a = attrs({ brand: 'unknown', colors: [], features: [], shape: 'unknown' });
    expect(attributeScore(a, attrs(), norm)).toBeGreaterThan(0.6);
  });
  it('mergeAttributes: 색 합집합, 신뢰도 높은 카테고리', () => {
    const m = mergeAttributes([attrs({ colors: ['검정'], confidence: 0.5, category: 'other' }), attrs({ colors: ['흰색'], confidence: 0.9 })])!;
    expect(m.category).toBe('earphones');
    expect(m.colors.sort()).toEqual(['검정', '흰색']);
    expect(mergeAttributes([null, undefined])).toBeNull();
  });
});
