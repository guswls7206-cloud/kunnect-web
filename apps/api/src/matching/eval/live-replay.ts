/**
 * 실제 API 라이브 평가(LIVE-RESULTS.generated.md)에서 얻은 AI 사진 점수를 그대로 재사용해(호출 0회),
 * 가중치/색상 규칙 변경 전·후의 총점·등급을 비교한다. `pnpm matching:replay`
 *
 * 한계: AI 점수는 SEND 모드 실측값이고, 색·카테고리·브랜드는 합성 그림의 정의(그린 그대로)를 쓴다. 실제 모델이 추출한 속성과 다를 수 있다.
 * 위치(같은 건물 다른 층 0.8)·태그(1.0)는 라이브 평가와 같게 고정했다. 마지막 행은 사용자가 보고한 실제 AirPods 사례(글 14·15)다.
 */
import { applyColorRule } from '../color.js';
import { composeScore } from '../scoring.js';
import { createTagNormalizer } from '../tags.js';
import type { PhotoAttributes } from '../types.js';
import { loadMatchingConfig } from '../weights.js';

const norm = createTagNormalizer();
const at = (category: PhotoAttributes['category'], colors: string[], brand = 'unknown'): PhotoAttributes => ({ category, colors, brand, shape: 'x', features: [], has_sensitive_info: false, confidence: 0.85 });

interface Row { id: string; kind: 'TRUE' | 'NEAR' | 'FAR'; note: string; ai: number; a: PhotoAttributes; b: PhotoAttributes; loc: number; tag: number }
const LOC = 0.8;
const ROWS: Row[] = [
  { id: 'T1', kind: 'TRUE', note: '같은 검정 케이스', ai: 0.7, a: at('earphones', ['검정']), b: at('earphones', ['검정']), loc: LOC, tag: 1 },
  { id: 'N1', kind: 'NEAR', note: '검정 vs 흰색 케이스', ai: 0.15, a: at('earphones', ['검정']), b: at('earphones', ['흰색']), loc: LOC, tag: 1 },
  { id: 'N2', kind: 'NEAR', note: '검정 케이스 스티커 유무', ai: 0.35, a: at('earphones', ['검정']), b: at('earphones', ['검정']), loc: LOC, tag: 1 },
  { id: 'T2', kind: 'TRUE', note: '같은 학생증', ai: 0.85, a: at('student_id', ['파란색']), b: at('student_id', ['파란색']), loc: LOC, tag: 1 },
  { id: 'N3', kind: 'NEAR', note: '이름·번호만 다른 학생증', ai: 0.05, a: at('student_id', ['파란색']), b: at('student_id', ['파란색']), loc: LOC, tag: 1 },
  { id: 'N4', kind: 'NEAR', note: '파랑 vs 빨강 학생증', ai: 0.15, a: at('student_id', ['파란색']), b: at('student_id', ['빨간색']), loc: LOC, tag: 1 },
  { id: 'T3', kind: 'TRUE', note: '같은 검정 우산', ai: 0.35, a: at('other', ['검정']), b: at('other', ['검정']), loc: LOC, tag: 1 },
  { id: 'N5', kind: 'NEAR', note: '우산 걸이형 vs 직선형', ai: 0.35, a: at('other', ['검정']), b: at('other', ['검정']), loc: LOC, tag: 1 },
  { id: 'T4', kind: 'TRUE', note: '같은 초록 텀블러', ai: 0.7, a: at('other', ['초록색']), b: at('other', ['초록색']), loc: LOC, tag: 1 },
  { id: 'N6', kind: 'NEAR', note: '초록 vs 파랑 텀블러', ai: 0.15, a: at('other', ['초록색']), b: at('other', ['파란색']), loc: LOC, tag: 1 },
  { id: 'T5', kind: 'TRUE', note: '같은 갈색 지갑', ai: 0.55, a: at('wallet', ['갈색']), b: at('wallet', ['갈색']), loc: LOC, tag: 1 },
  { id: 'N7', kind: 'NEAR', note: '비슷한 갈색 지갑', ai: 0.45, a: at('wallet', ['갈색']), b: at('wallet', ['갈색']), loc: LOC, tag: 1 },
  { id: 'N8', kind: 'NEAR', note: '흰 보조배터리 ANKER vs BASEUS', ai: 0.15, a: at('other', ['흰색'], 'Anker'), b: at('other', ['흰색'], 'Baseus'), loc: LOC, tag: 1 },
  { id: 'F1', kind: 'FAR', note: '우산 vs 텀블러', ai: 0.0, a: at('other', ['검정']), b: at('other', ['초록색']), loc: LOC, tag: 1 },
  { id: 'F2', kind: 'FAR', note: '노트북 vs 지갑(태그 동일)', ai: 0.15, a: at('laptop', ['회색']), b: at('wallet', ['갈색']), loc: LOC, tag: 1 },
  { id: 'F3', kind: 'FAR', note: '검정 케이스 vs 검정 학생증(프리셋 태그 없음 가정, 속성은 other/student_id)', ai: 0.15, a: at('other', ['검정']), b: at('student_id', ['검정']), loc: LOC, tag: 1 },
  { id: 'AIRPODS', kind: 'TRUE', note: '실제 사례 글 14·15: AI 오인식(마우스), 위치 0.352, 태그 0.667', ai: 0.15, a: at('earphones', ['흰색']), b: at('other', ['흰색', '회색']), loc: 0.352, tag: 0.667 },
];

const before = loadMatchingConfig({ MATCH_W_PHOTO: '0.5', MATCH_W_LOCATION: '0.25', MATCH_W_TAG: '0.25', MATCH_COLOR_FLOOR: '0' });
const wOnly = loadMatchingConfig({ MATCH_COLOR_FLOOR: '0' });
const after = loadMatchingConfig({ MATCH_COLOR_AUTO_MIN_AI: '0' }); // 색 규칙만(안전장치 없음)
const guarded = loadMatchingConfig({}); // 기본값: 색 규칙 + 안전장치(MATCH_COLOR_AUTO_MIN_AI=0.5)
const grade = (s: number) => (s >= 0.8 ? 'AUTO' : s >= 0.6 ? 'CAND' : 'IGN');
const tot = (cfg: typeof after, r: Row) => composeScore({ photo: applyColorRule(r.ai, r.a, r.b, cfg, norm).photo, location: r.loc, tag: r.tag }, cfg);

// 완화 옵션 시뮬레이션: 색 하한이 적용됐고 AI 원점수가 기준 미만이면 AUTO → CAND (pipeline 과 같은 규칙)
const guardGrade = (r: Row, cfg: typeof after) => {
  const cr = applyColorRule(r.ai, r.a, r.b, cfg, norm);
  const g = grade(composeScore({ photo: cr.photo, location: r.loc, tag: r.tag }, cfg));
  return g === 'AUTO' && cfg.color.autoMinAi > 0 && cr.rule === 'FLOOR' && r.ai < cfg.color.autoMinAi ? 'CAND' : g;
};
console.log('| 쌍 | 정답 | AI 사진 점수 | 색 규칙 | 사진(후) | 총점 전 | 총점 가중치만 | 총점 후(안전장치 없음) | 등급 전 → 후(안전장치 없음) | 후: 기본값(안전장치 AI≥0.5) | 설명 |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|');
let falseAuto = 0, falseCand = 0, trueAuto = 0, trueCand = 0, gFalseAuto = 0, gTrueAuto = 0;
for (const r of ROWS) {
  const cr = applyColorRule(r.ai, r.a, r.b, after, norm);
  const t0 = tot(before, r), t1 = tot(wOnly, r), t2 = tot(after, r);
  if (r.id !== 'AIRPODS') {
    if (r.kind !== 'TRUE') { if (grade(t2) === 'AUTO') falseAuto++; if (grade(t2) !== 'IGN') falseCand++; if (guardGrade(r, guarded) === 'AUTO') gFalseAuto++; }
    else { if (grade(t2) === 'AUTO') trueAuto++; if (grade(t2) !== 'IGN') trueCand++; if (guardGrade(r, guarded) === 'AUTO') gTrueAuto++; }
  }
  const mark = grade(t0) !== grade(t2) ? ' **' : '';
  console.log(`| ${r.id} | ${r.kind} | ${r.ai.toFixed(2)} | ${cr.rule} | ${cr.photo.toFixed(2)} | ${t0.toFixed(3)} | ${t1.toFixed(3)} | ${t2.toFixed(3)} | ${grade(t0)} → ${grade(t2)}${mark} | ${guardGrade(r, guarded)} | ${r.note} |`);
}
console.log(`\n(후) 오답(NEAR/FAR 11쌍) 중 AUTO ${falseAuto}건 / 후보 이상 ${falseCand}건, 정답 5쌍 중 AUTO ${trueAuto}건 / 후보 이상 ${trueCand}건 (AIRPODS 제외, 안전장치 없음 기준)`);
console.log(`(기본값: 안전장치 AI≥0.5) 오답 중 AUTO ${gFalseAuto}건, 정답 중 AUTO ${gTrueAuto}건`);
