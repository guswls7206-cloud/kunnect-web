import { describe, expect, it } from 'vitest';
import { DATASET } from '../eval/dataset.js';
import { BASE, metrics, poolEval, scoreAll, type Scored } from '../eval/harness.js';

describe('평가 데이터셋 무결성', () => {
  it('40쌍 이상, id 유일, 라벨 3종 혼합, 사진 있음/없음 혼합', () => {
    expect(DATASET.length).toBeGreaterThanOrEqual(40);
    expect(new Set(DATASET.map((d) => d.id)).size).toBe(DATASET.length);
    for (const l of ['TRUE', 'NEAR', 'FAR']) expect(DATASET.some((d) => d.label === l)).toBe(true);
    expect(DATASET.some((d) => d.bothPhotos)).toBe(true);
    expect(DATASET.some((d) => !d.bothPhotos)).toBe(true);
  });
  it('분실/습득 유형·id 규칙', () => {
    for (const d of DATASET) {
      expect(d.lost.type).toBe('LOST');
      expect(d.found.type).toBe('FOUND');
      expect(d.bothPhotos).toBe(d.lost.photos.length > 0 && d.found.photos.length > 0);
    }
  });
});

describe('평가 지표 계산', () => {
  const mk = (label: 'TRUE' | 'NEAR' | 'FAR', score: number, excluded = false): Scored => ({
    pair: { ...DATASET[0]!, label },
    score,
    excluded,
  });
  it('AUTO/후보 TP·FP, 정밀도·재현율·false-AUTO율', () => {
    const m = metrics([mk('TRUE', 0.9), mk('TRUE', 0.7), mk('TRUE', 0.4), mk('NEAR', 0.9), mk('FAR', 0.1)], 0.8, 0.6);
    expect(m).toMatchObject({ pos: 3, neg: 2, autoTP: 1, autoFP: 1, candTP: 2, candFP: 1 });
    expect(m.autoPrecision).toBeCloseTo(0.5);
    expect(m.autoRecall).toBeCloseTo(1 / 3);
    expect(m.falseAutoRate).toBeCloseTo(0.5);
    expect(m.candRecall).toBeCloseTo(2 / 3);
  });
  it('제외된 쌍은 어떤 등급에도 속하지 않고 정답이면 놓친 것으로 센다', () => {
    const m = metrics([mk('TRUE', 0, true), mk('NEAR', 0, true)], 0.8, 0.6);
    expect(m.autoTP + m.autoFP + m.candTP + m.candFP).toBe(0);
    expect(m.autoRecall).toBe(0);
  });
  it('정밀도 분모 0이면 null', () => {
    expect(metrics([mk('TRUE', 0.1)], 0.8, 0.6).autoPrecision).toBeNull();
  });
});

describe('AUTO 비활성화 설정', () => {
  it('MATCH_AUTO_THRESHOLD_NOPHOTO=2 이면 사진 없음 쌍은 AUTO가 될 수 없다', async () => {
    const { loadMatchingConfig } = await import('../weights.js');
    const { createMatchingEngine } = await import('../pipeline.js');
    const cfg = loadMatchingConfig({ MATCH_AUTO_THRESHOLD_NOPHOTO: '2' });
    expect(cfg.autoThresholdNoPhoto).toBe(2);
    const r = await createMatchingEngine({ config: cfg }).matchPair(DATASET[1]!.lost, DATASET[1]!.found); // T02: 사진 없음, 점수 0.9
    expect(r.score).toBeGreaterThanOrEqual(0.85);
    expect(r.grade).toBe('CANDIDATE');
  });
});

describe('평가 하네스 회귀(현재 기본 설정)', () => {
  it('사진 모드는 양쪽 사진 쌍만 평가', () => {
    expect(scoreAll(DATASET, BASE, 'photo')).toHaveLength(DATASET.filter((d) => d.bothPhotos).length);
  });
  it('시간 제외·카테고리 충돌·동일 작성자 쌍은 항상 제외', () => {
    const excluded = scoreAll(DATASET, BASE, 'nophoto').filter((s) => ['N10', 'N11', 'N12'].includes(s.pair.id));
    expect(excluded.every((s) => s.excluded)).toBe(true);
  });
  it('브랜드가 다른 보조배터리(N08)는 사진 모드에서 AUTO가 아니다(브랜드 불일치 감점 회귀)', () => {
    const n08 = scoreAll(DATASET, BASE, 'photo').find((s) => s.pair.id === 'N08')!;
    expect(n08.score).toBeLessThan(BASE.autoThreshold);
  });
  it('풀 평가: 사진 없음 AUTO를 막으면 false-AUTO가 줄어든다', () => {
    const open = poolEval(BASE, { autoPhoto: 0.8, autoNoPhoto: 0.85 });
    const cap = poolEval(BASE, { autoPhoto: 0.8, autoNoPhoto: 0.85, capNoPhoto: true });
    expect(cap.falseAutoPerLost).toBeLessThan(open.falseAutoPerLost);
    expect(cap.trueCandRate).toBe(open.trueCandRate); // 후보 노출은 동일
  });
});
