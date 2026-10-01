/**
 * 평가 실행: `pnpm matching:eval` — 표를 출력하고 eval/RESULTS.md(자동 생성)를 갱신한다.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sensitivityOf } from '../exposure.js';
import { createTagNormalizer } from '../tags.js';
import type { PostInput } from '../types.js';
import { DATASET } from './dataset.js';
import { BASE, HEADER, metrics, poolEval, row, scoreAll, type Scored } from './harness.js';
import { loadMatchingConfig, type MatchingConfig } from '../weights.js';

const out: string[] = [];
const p = (s = '') => out.push(s);

const w = (photo: number, location: number, tag: number): MatchingConfig => ({ ...BASE, weights: { photo, location, tag } });
const wn = (location: number, tag: number): MatchingConfig => ({ ...BASE, noPhotoWeights: { location, tag } });

const count = (l: string) => DATASET.filter((d) => d.label === l).length;
p(`데이터셋: ${DATASET.length}쌍 (TRUE ${count('TRUE')} / NEAR ${count('NEAR')} / FAR ${count('FAR')}), 양쪽 사진 ${DATASET.filter((d) => d.bothPhotos).length}쌍`);
p();

// ── 1. 사진 모드 ──
const photoBase = scoreAll(DATASET, BASE, 'photo');
p('## 1. 사진 모드 (양쪽 사진 속성 있음)');
p();
p('### 1-1. AUTO 임계값 스윕 (가중치 0.45/0.25/0.30 + 색상 규칙, 후보 0.60)');
p(HEADER);
for (const a of [0.7, 0.75, 0.8, 0.85, 0.9]) p(row(`AUTO ≥ ${a.toFixed(2)}${a === 0.8 ? ' (현재)' : ''}`, metrics(photoBase, a, 0.6)));
p();
p('### 1-2. 가중치 민감도 (AUTO 0.80 / 후보 0.60)');
p(HEADER);
for (const [ph, lo, tg] of [[0.45, 0.25, 0.3], [0.5, 0.25, 0.25], [0.34, 0.33, 0.33], [0.4, 0.3, 0.3], [0.6, 0.2, 0.2], [0.7, 0.15, 0.15], [0.5, 0.1, 0.4], [0.5, 0.4, 0.1]] as const) {
  p(row(`사진 ${ph} / 위치 ${lo} / 태그 ${tg}${ph === 0.45 && lo === 0.25 ? ' (현재)' : ''}`, metrics(scoreAll(DATASET, w(ph, lo, tg), 'photo'), 0.8, 0.6)));
}
p();

// ── 2. 사진 없음 모드 ──
const noPhotoBase = scoreAll(DATASET, BASE, 'nophoto');
p('## 2. 사진 없음 모드 (모든 쌍에서 사진을 제거하고 위치·태그만 사용)');
p();
p('### 2-1. AUTO 임계값 스윕 (위치 0.5 / 태그 0.5, 후보 0.60)');
p(HEADER);
for (const a of [0.75, 0.8, 0.85, 0.9, 0.95]) p(row(`AUTO ≥ ${a.toFixed(2)}${a === 0.85 ? ' (현재)' : ''}`, metrics(noPhotoBase, a, 0.6)));
p(row('cap: AUTO 없음(후보 ≥0.60까지만, 알림 없음)', metrics(noPhotoBase, 2, 0.6)));
p(row('cap: AUTO 없음(후보 ≥0.70까지만)', metrics(noPhotoBase, 2, 0.7)));
p();
p('### 2-2. 가중치 민감도 (AUTO 0.85 / 후보 0.60)');
p(HEADER);
for (const [lo, tg] of [[0.5, 0.5], [0.3, 0.7], [0.4, 0.6], [0.6, 0.4], [0.7, 0.3], [0.2, 0.8]] as const) {
  p(row(`위치 ${lo} / 태그 ${tg}${lo === 0.5 ? ' (현재)' : ''}`, metrics(scoreAll(DATASET, wn(lo, tg), 'nophoto'), 0.85, 0.6)));
}
p();

// ── 3. 풀 평가 ──
p('## 3. 풀 평가: 새 분실글 1건 vs 기존 습득글 전체 (제품 혼합 정책)');
p();
p(`분실글 ${DATASET.filter((d) => d.label === 'TRUE').length}건 × 습득글 풀 ${DATASET.length}건. 정답은 분실글당 1건. 사진 있음 쌍은 사진 모드(0.80), 그 외는 사진 없음 모드.`);
p();
p('| 정책 | 분실글당 false-AUTO | 정답 AUTO율 | 분실글당 false-후보 | 정답 후보 이상율 |\n|---|---|---|---|---|');
const pools: [string, Parameters<typeof poolEval>[1]][] = [
  ['사진 없음 AUTO 0.85 (현재)', { autoPhoto: 0.8, autoNoPhoto: 0.85 }],
  ['사진 없음 AUTO 0.90', { autoPhoto: 0.8, autoNoPhoto: 0.9 }],
  ['사진 없음 AUTO 0.95', { autoPhoto: 0.8, autoNoPhoto: 0.95 }],
  ['사진 없음 AUTO 없음(cap, 후보까지)', { autoPhoto: 0.8, autoNoPhoto: 0.85, capNoPhoto: true }],
];
for (const [label, o] of pools) {
  const r = poolEval(BASE, o);
  p(`| ${label} | ${r.falseAutoPerLost.toFixed(2)} | ${(r.trueAutoRate * 100).toFixed(0)}% | ${r.falseCandPerLost.toFixed(2)} | ${(r.trueCandRate * 100).toFixed(0)}% |`);
}
p();

// ── 3-2. 변경 전/후 (사용자 결정: 가중치 + 색상 규칙) ──
const before = loadMatchingConfig({ MATCH_W_PHOTO: '0.5', MATCH_W_LOCATION: '0.25', MATCH_W_TAG: '0.25', MATCH_COLOR_FLOOR: '0' });
const weightsOnly = loadMatchingConfig({ MATCH_COLOR_FLOOR: '0' });
const after = loadMatchingConfig({});
p('## 3-2. 변경 전/후 비교 (사진 모드 18쌍, AUTO 0.80 / 후보 0.60)');
p();
p('전: 0.5/0.25/0.25, 색 규칙 없음 / 가중치만: 0.45/0.25/0.30, 색 규칙 없음 / 후: 0.45/0.25/0.30 + 색 하한 0.70');
p();
p(HEADER);
p(row('전 (0.5/0.25/0.25)', metrics(scoreAll(DATASET, before, 'photo'), 0.8, 0.6)));
p(row('가중치만 (0.45/0.25/0.30)', metrics(scoreAll(DATASET, weightsOnly, 'photo'), 0.8, 0.6)));
p(row('후 (+ 색상 규칙)', metrics(scoreAll(DATASET, after, 'photo'), 0.8, 0.6)));
p();
const gradeOf = (s: Scored) => (s.excluded ? 'EXCL' : s.score >= 0.8 ? 'AUTO' : s.score >= 0.6 ? 'CAND' : 'IGN');
const bs = scoreAll(DATASET, before, 'photo');
const as = scoreAll(DATASET, after, 'photo');
p('등급이 바뀐 쌍(전 → 후):');
const changed = bs.map((b, i) => ({ b, a: as[i]! })).filter(({ b, a }) => gradeOf(b) !== gradeOf(a));
out.push(...(changed.length ? changed.map(({ b, a }) => `- ${b.pair.id} (${b.pair.label}) ${gradeOf(b)} ${b.score.toFixed(3)} → ${gradeOf(a)} ${a.score.toFixed(3)}: ${b.pair.note}`) : ['- 없음']));
p();

// ── 3-3. 민감 글(SKIP → 사진 없음 취급) 위험 ──
const normSens = createTagNormalizer();
const isSens = (x: PostInput) => { const s = sensitivityOf(x, BASE.exposure, normSens); return s.expected || s.detected; };
const sensScored = noPhotoBase.filter((s) => isSens(s.pair.lost) || isSens(s.pair.found));
p('## 3-3. 민감 글(학생증·카드·지갑 등)은 기본 SKIP 이라 사진 없음(NO_PHOTO) 평가 — 위험 수치');
p();
p(`민감 글이 낀 쌍 ${sensScored.length}쌍(정답 ${sensScored.filter((s) => s.pair.label === 'TRUE').length}). 위치 0.5 / 태그 0.5, AUTO 0.85, 후보 0.60.`);
p();
p(HEADER);
p(row('AUTO ≥ 0.85 (현재: 엔진 기본)', metrics(sensScored, 0.85, 0.6)));
p(row('민감 글 AUTO 금지(MATCH_SENSITIVE_NEVER_AUTO, 후보까지만)', metrics(sensScored, 2, 0.6)));
p();
p('민감 글 쌍 중 AUTO 로 판정되는 오답:');
const sensFp = sensScored.filter((s) => s.pair.label !== 'TRUE' && !s.excluded && s.score >= 0.85);
out.push(...(sensFp.length ? sensFp.map((s) => `- ${s.pair.id} (${s.pair.label}, ${s.score.toFixed(3)}): ${s.pair.note}`) : ['- 없음']));
p();

// ── 4. 실패 사례 ──
const fmt = (s: Scored) => `- \`${s.pair.id}\` (${s.pair.label}, 점수 ${s.excluded ? '제외' : s.score.toFixed(3)}): ${s.pair.note}`;
p('## 4. 실패 사례 (현재 설정)');
p();
p('### 사진 없음 모드, AUTO 0.85 기준');
p('**놓친 정답(점수 < 0.60 → 후보에도 안 뜸)**');
const missNo = noPhotoBase.filter((s) => s.pair.label === 'TRUE' && (s.excluded || s.score < 0.6));
out.push(...(missNo.length ? missNo.map(fmt) : ['- 없음']));
p('**AUTO 알림이 가는 오탐**');
const fpNo = noPhotoBase.filter((s) => s.pair.label !== 'TRUE' && !s.excluded && s.score >= 0.85);
out.push(...(fpNo.length ? fpNo.map(fmt) : ['- 없음']));
p('**정답인데 AUTO가 아닌 경우(후보 구간)**');
const candNo = noPhotoBase.filter((s) => s.pair.label === 'TRUE' && !s.excluded && s.score >= 0.6 && s.score < 0.85);
out.push(...(candNo.length ? candNo.map(fmt) : ['- 없음']));
p();
p('### 사진 모드, AUTO 0.80 기준');
p('**놓친 정답(< 0.60)**');
const missPh = photoBase.filter((s) => s.pair.label === 'TRUE' && (s.excluded || s.score < 0.6));
out.push(...(missPh.length ? missPh.map(fmt) : ['- 없음']));
p('**AUTO 오탐**');
const fpPh = photoBase.filter((s) => s.pair.label !== 'TRUE' && !s.excluded && s.score >= 0.8);
out.push(...(fpPh.length ? fpPh.map(fmt) : ['- 없음']));
p('**정답인데 AUTO가 아닌 경우(후보 구간)**');
const candPh = photoBase.filter((s) => s.pair.label === 'TRUE' && !s.excluded && s.score >= 0.6 && s.score < 0.8);
out.push(...(candPh.length ? candPh.map(fmt) : ['- 없음']));

const md = out.join('\n');
console.log(md);
if (process.argv.includes('--write')) {
  const target = fileURLToPath(new URL('./RESULTS.generated.md', import.meta.url));
  writeFileSync(target, `<!-- 자동 생성: pnpm matching:eval:write — 직접 수정하지 마세요 -->\n\n${md}\n`);
  console.log(`\n→ ${target}`);
}
