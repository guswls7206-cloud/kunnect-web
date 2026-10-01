/**
 * 실제 Claude API 를 쓰는 소규모 재평가(합성 이미지). `pnpm matching:live` — ANTHROPIC_API_KEY 필요, 호출 예산 하드 상한.
 *
 * - 이미지는 sharp(SVG)로 만든 단순한 물건 그림이다. 학생증 모양 카드는 **가짜 이름/번호(SAMPLE)** 만 쓴다.
 * - 호출 예산(기본 100, LIVE_CALL_BUDGET 으로 낮출 수 있음)을 CounterStore 로 강제한다(재시도 포함). 초과하면 AI 단계가 degraded 로 처리된다.
 * - 첫 호출이 401(키 오류)이면 즉시 중단해 예산을 쓰지 않는다.
 * - 결과를 표로 출력하고 eval/LIVE-RESULTS.generated.md 에 저장한다. 키는 어디에도 출력·저장하지 않는다.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { ClaudeClient, type AiLogger, type MessagesLike } from '../claude.js';
import Anthropic from '@anthropic-ai/sdk';
import { prepareImageForAi } from '../image.js';
import { InMemoryCounterStore } from '../limiter.js';
import { createMatchingEngine } from '../pipeline.js';
import type { LocationRef, PostInput } from '../types.js';
import { loadMatchingConfig } from '../weights.js';

type Kind = 'TRUE' | 'NEAR' | 'FAR';
type Shape = { svg: string };

const W = 800;
const H = 600;
const svg = (bg: string, body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="${bg}"/>${body}</svg>`;

// ── 물건 그리기 (variant 로 같은 물건의 다른 사진을 흉내: 배경·위치·기울기 변화) ──
function earphoneCase(color: string, v: 0 | 1, sticker = true): string {
  const rot = v ? -8 : 0;
  const dx = v ? 40 : 0;
  return svg(v ? '#d9e2ec' : '#f2efe8', `<g transform="translate(${400 + dx} 300) rotate(${rot})"><rect x="-170" y="-110" width="340" height="220" rx="80" fill="${color}"/><rect x="-170" y="-10" width="340" height="6" fill="#00000033"/>${sticker ? '<circle cx="90" cy="40" r="22" fill="#ffcc00"/>' : ''}</g>`);
}
function card(name: string, number: string, v: 0 | 1, accent = '#1f4fa8'): string {
  const rot = v ? 6 : 0;
  return svg(v ? '#e6e0d4' : '#f5f5f5', `<g transform="translate(400 300) rotate(${rot})"><rect x="-230" y="-145" width="460" height="290" rx="22" fill="${accent}"/><rect x="-230" y="-145" width="460" height="60" rx="22" fill="#ffffff22"/><rect x="-200" y="-60" width="110" height="140" fill="#cfd8e6"/><circle cx="-145" cy="-15" r="30" fill="#8a97ad"/><text x="-60" y="-20" font-size="30" fill="#fff" font-family="Arial">${name}</text><text x="-60" y="30" font-size="26" fill="#fff" font-family="Arial">${number}</text><text x="-60" y="90" font-size="20" fill="#ffffffcc" font-family="Arial">SAMPLE UNIVERSITY</text></g>`);
}
function umbrella(color: string, v: 0 | 1, hook = true): string {
  return svg(v ? '#e8ecef' : '#f4f1ea', `<g transform="translate(${v ? 380 : 400} 300) rotate(${v ? 12 : 0})"><path d="M-220 -40 Q0 -240 220 -40 Z" fill="${color}"/><rect x="-4" y="-40" width="8" height="230" fill="#444"/>${hook ? '<path d="M-4 190 q0 40 -40 40 q-30 0 -30 -26" stroke="#444" stroke-width="8" fill="none"/>' : '<rect x="-14" y="190" width="28" height="26" rx="6" fill="#444"/>'}</g>`);
}
function bottle(color: string, v: 0 | 1): string {
  return svg(v ? '#dfe7e1' : '#f3f1ec', `<g transform="translate(${v ? 420 : 400} 300) rotate(${v ? -10 : 0})"><rect x="-70" y="-170" width="140" height="340" rx="40" fill="${color}"/><rect x="-50" y="-210" width="100" height="50" rx="14" fill="#333"/><rect x="-70" y="-30" width="140" height="10" fill="#ffffff55"/></g>`);
}
function wallet(color: string, v: 0 | 1, stitch = false): string {
  return svg(v ? '#e7e2da' : '#f4f2ee', `<g transform="translate(400 300) rotate(${v ? 7 : 0})"><rect x="-190" y="-120" width="380" height="240" rx="28" fill="${color}"/>${stitch ? '<rect x="-170" y="-100" width="340" height="200" rx="18" fill="none" stroke="#f1d9a8" stroke-width="4" stroke-dasharray="10 8"/>' : ''}<rect x="150" y="-20" width="40" height="40" fill="#00000033"/></g>`);
}
function powerbank(color: string, label: string, v: 0 | 1): string {
  return svg(v ? '#dde3ea' : '#f2f2f2', `<g transform="translate(400 300) rotate(${v ? -6 : 0})"><rect x="-210" y="-90" width="420" height="180" rx="26" fill="${color}"/><text x="-150" y="15" font-size="40" fill="#333" font-family="Arial">${label}</text><rect x="150" y="-50" width="30" height="16" fill="#44bb55"/></g>`);
}
function laptop(color: string, v: 0 | 1): string {
  return svg(v ? '#e3e6ea' : '#f4f4f4', `<g transform="translate(400 300) rotate(${v ? 5 : 0})"><rect x="-230" y="-150" width="460" height="290" rx="14" fill="${color}"/><rect x="-210" y="-130" width="420" height="250" fill="#222"/><rect x="-280" y="140" width="560" height="26" rx="8" fill="${color}"/></g>`);
}

interface Item {
  id: string;
  label: string;
  /** 사진 */
  shape: Shape;
  tags: string[];
  category?: string; // preset tag
}
const item = (id: string, label: string, svgStr: string, presetTags: string[], tags: string[]): Item => ({ id, label, shape: { svg: svgStr }, tags, category: presetTags[0] });

const LOC: LocationRef = { id: 'loc-1', buildingId: 'b-1', buildingName: '학생회관(더미)', floor: 1, groupId: 'g', lat: 37, lng: 127 };
const LOC2: LocationRef = { ...LOC, id: 'loc-2', floor: 2 };

interface PairSpec { id: string; kind: Kind; note: string; lost: Item; found: Item; expectedMin?: number; expectedMax?: number; sensitive?: boolean }

function buildPairs(): PairSpec[] {
  const ear = (id: string, color: string, v: 0 | 1, st = true) => item(id, `이어폰 케이스 ${color}`, earphoneCase(color, v, st), ['earphones'], ['검정']);
  return [
    { id: 'T1', kind: 'TRUE', note: '같은 검정 케이스, 다른 각도·배경', lost: ear('e1a', '#161616', 0), found: ear('e1b', '#161616', 1) },
    { id: 'N1', kind: 'NEAR', note: '검정 vs 흰색 케이스', lost: ear('e2a', '#161616', 0), found: item('e2b', '흰 케이스', earphoneCase('#f1f1f1', 1, true), ['earphones'], ['검정']) },
    { id: 'N2', kind: 'NEAR', note: '검정 케이스(스티커 있음) vs 검정 케이스(스티커 없음)', lost: ear('e3a', '#161616', 0, true), found: ear('e3b', '#1a1a1a', 1, false) },
    { id: 'T2', kind: 'TRUE', note: '같은 가짜 학생증 두 장면(SAMPLE KIM 0000)', lost: item('c1a', '학생증', card('KIM SAMPLE', '0000-0000', 0), ['student_id'], ['학생증']), found: item('c1b', '학생증', card('KIM SAMPLE', '0000-0000', 1), ['student_id'], ['학생증']), sensitive: true },
    { id: 'N3', kind: 'NEAR', note: '같은 모양 다른 가짜 학생증(이름·번호만 다름)', lost: item('c2a', '학생증', card('KIM SAMPLE', '0000-0000', 0), ['student_id'], ['학생증']), found: item('c2b', '학생증', card('LEE SAMPLE', '1111-1111', 1), ['student_id'], ['학생증']), sensitive: true },
    { id: 'N4', kind: 'NEAR', note: '파란 vs 빨간 학생증', lost: item('c3a', '학생증', card('KIM SAMPLE', '0000-0000', 0), ['student_id'], ['학생증']), found: item('c3b', '학생증', card('KIM SAMPLE', '0000-0000', 1, '#b3261e'), ['student_id'], ['학생증']), sensitive: true },
    { id: 'T3', kind: 'TRUE', note: '같은 검정 우산(걸이형)', lost: item('u1a', '검정 우산', umbrella('#151515', 0), [], ['우산', '검정']), found: item('u1b', '검정 우산', umbrella('#151515', 1), [], ['우산', '검정']) },
    { id: 'N5', kind: 'NEAR', note: '검정 우산 걸이형 vs 직선형', lost: item('u2a', '검정 우산', umbrella('#151515', 0, true), [], ['우산', '검정']), found: item('u2b', '검정 우산', umbrella('#151515', 1, false), [], ['우산', '검정']) },
    { id: 'T4', kind: 'TRUE', note: '같은 초록 텀블러', lost: item('b1a', '초록 텀블러', bottle('#1f8a4c', 0), [], ['텀블러', '초록']), found: item('b1b', '초록 텀블러', bottle('#1f8a4c', 1), [], ['텀블러', '초록']) },
    { id: 'N6', kind: 'NEAR', note: '초록 vs 파랑 텀블러', lost: item('b2a', '텀블러', bottle('#1f8a4c', 0), [], ['텀블러']), found: item('b2b', '텀블러', bottle('#1f5fb0', 1), [], ['텀블러']) },
    { id: 'T5', kind: 'TRUE', note: '같은 갈색 지갑(스티치)', lost: item('w1a', '갈색 지갑', wallet('#7a4b2a', 0, true), ['wallet'], ['갈색']), found: item('w1b', '갈색 지갑', wallet('#7a4b2a', 1, true), ['wallet'], ['갈색']), sensitive: true },
    { id: 'N7', kind: 'NEAR', note: '갈색 지갑 스티치 있음/없음, 색 약간 다름', lost: item('w2a', '지갑', wallet('#7a4b2a', 0, true), ['wallet'], ['갈색']), found: item('w2b', '지갑', wallet('#8f5a33', 1, false), ['wallet'], ['갈색']), sensitive: true },
    { id: 'N8', kind: 'NEAR', note: '흰 보조배터리 ANKER vs BASEUS', lost: item('p1a', '보조배터리', powerbank('#f4f4f4', 'ANKER', 0), [], ['보조배터리', '흰색']), found: item('p1b', '보조배터리', powerbank('#f4f4f4', 'BASEUS', 1), [], ['보조배터리', '흰색']) },
    { id: 'F1', kind: 'FAR', note: '우산 vs 텀블러', lost: item('f1a', '우산', umbrella('#151515', 0), [], ['우산']), found: item('f1b', '텀블러', bottle('#1f8a4c', 1), [], ['텀블러']) },
    { id: 'F2', kind: 'FAR', note: '노트북 vs 지갑(태그 동일하게 두어 사진 신호만 평가)', lost: item('f2a', '물건', laptop('#8a8f98', 0), [], ['회색']), found: item('f2b', '물건', wallet('#7a4b2a', 1, true), [], ['회색']) },
    { id: 'F3', kind: 'FAR', note: '검정 케이스 vs 학생증(태그 동일)', lost: item('f3a', '검정 물건', earphoneCase('#161616', 0), [], ['검정']), found: item('f3b', '검정 물건', card('KIM SAMPLE', '0000-0000', 1, '#161616'), [], ['검정']) },
  ];
}

async function toJpegB64(svgStr: string): Promise<string> {
  const png = await sharp(Buffer.from(svgStr)).png().toBuffer();
  return (await prepareImageForAi(png, loadMatchingConfig().image)).base64;
}

const toPost = async (id: string, type: 'LOST' | 'FOUND', it: Item, loc: LocationRef, author: string): Promise<PostInput> => ({
  id,
  type,
  authorId: author,
  title: it.label,
  presetTags: it.category ? [it.category] : [],
  customTags: it.tags,
  occurredAt: new Date().toISOString(),
  location: loc,
  photos: [{ id: `${id}-ph`, base64: await toJpegB64(it.shape.svg), mediaType: 'image/jpeg' }],
});

async function main() {
  // 키 없이 생성된 이미지를 눈으로 확인하는 용도: LIVE_DUMP_DIR=경로 pnpm matching:live
  if (process.env.LIVE_DUMP_DIR) {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(process.env.LIVE_DUMP_DIR, { recursive: true });
    for (const p of buildPairs()) for (const [side, it] of [['L', p.lost], ['F', p.found]] as const) await sharp(Buffer.from(it.shape.svg)).png().toFile(`${process.env.LIVE_DUMP_DIR}/${p.id}-${side}.png`);
    console.log('이미지 저장 완료');
    return;
  }
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) {
    console.log('ANTHROPIC_API_KEY 미설정: 라이브 평가를 건너뜁니다.');
    return;
  }
  const budget = Math.min(Number(process.env.LIVE_CALL_BUDGET ?? 100) || 100, 100);
  const sensitiveModes = (process.env.LIVE_SENSITIVE_MODES ?? 'SEND,BLUR').split(',').map((s) => s.trim());
  const usage = { calls: 0, inTok: 0, outTok: 0, latencies: [] as number[], fails: 0, status: new Map<string, number>() };
  const logger: AiLogger = {
    info: (e) => {
      usage.calls++;
      usage.inTok += Number(e.inputTokens ?? 0);
      usage.outTok += Number(e.outputTokens ?? 0);
      usage.latencies.push(Number(e.latencyMs ?? 0));
    },
    warn: (e) => {
      usage.calls++;
      usage.fails++;
      usage.status.set(String(e.status ?? e.error ?? '?'), (usage.status.get(String(e.status ?? e.error ?? '?')) ?? 0) + 1);
    },
  };

  const mkEngine = (mode: 'SEND' | 'BLUR' | 'SKIP') => {
    const config = loadMatchingConfig({ AI_SENSITIVE_MODE: mode, AI_DAILY_CALL_LIMIT: String(budget) });
    const sdk = new Anthropic({ apiKey: key, maxRetries: 0 });
    const client = new ClaudeClient({ config, messages: sdk.messages as unknown as MessagesLike, logger, counterStore: new InMemoryCounterStore() });
    return { engine: createMatchingEngine({ client, config }), client, config };
  };

  const only = (process.env.LIVE_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const pairs = buildPairs().filter((p) => only.length === 0 || only.includes(p.id));
  const rows: string[] = [];
  const results: { id: string; kind: Kind; mode: string; score: number; photo?: number; grade: string; degraded: boolean; reason?: string; sensitive?: string }[] = [];

  for (const mode of sensitiveModes as ('SEND' | 'BLUR' | 'SKIP')[]) {
    const { engine, client } = mkEngine(mode);
    for (const p of pairs) {
      if (mode !== sensitiveModes[0] && !p.sensitive) continue; // 비민감 쌍은 첫 모드에서만 평가해 예산 절약
      if ((await client.callsToday()) >= budget) {
        console.warn('호출 예산 소진: 중단합니다.');
        break;
      }
      let lost = await toPost(`${p.id}-L`, 'LOST', p.lost, LOC, 'u1');
      let found = await toPost(`${p.id}-F`, 'FOUND', p.found, LOC2, 'u2');
      const [exL, exF] = await Promise.all([engine.extractAttributes(lost), engine.extractAttributes(found)]);
      lost = { ...lost, photos: lost.photos.map((ph) => ({ ...ph, attributes: exL.photos[0]?.attributes ?? null })) };
      found = { ...found, photos: found.photos.map((ph) => ({ ...ph, attributes: exF.photos[0]?.attributes ?? null })) };
      if (exL.photos[0]?.status === 'FAILED' && usage.status.get('401')) {
        console.error('401(인증 실패): 키를 확인하세요. 예산을 더 쓰지 않고 중단합니다.');
        process.exitCode = 2;
        return;
      }
      const r = await engine.matchPair(lost, found);
      const sens = [exL.photos[0]?.sensitive, exF.photos[0]?.sensitive].filter(Boolean).map((s) => s!.kinds.join('+')).join('/');
      results.push({ id: p.id, kind: p.kind, mode, score: r.score, photo: r.breakdown.photo, grade: r.grade, degraded: r.degraded, reason: r.aiReason, sensitive: sens || undefined });
      const ex = (e: typeof exL) => {
        const a = e.photos[0]?.attributes;
        return a ? `${a.category}/${a.colors.join('+')}/${a.brand}` : '–';
      };
      rows.push(`| ${p.id} | ${p.kind} | ${mode} | ${p.note} | ${r.breakdown.photoRaw?.toFixed(2) ?? '–'} → ${r.breakdown.photo?.toFixed(2) ?? '–'} (${r.colorRule ?? '–'}) | ${r.score.toFixed(3)} | ${r.grade}${r.degraded ? '(degraded)' : ''} | ${ex(exL)} ↔ ${ex(exF)} | ${sens || '–'} | ${(r.aiReason ?? '').slice(0, 40)} |`);
    }
  }

  const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const p95 = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.95)] ?? 0;
  // 가격은 [가정/제안]: Haiku 4.5 입력 $1/M, 출력 $5/M 토큰(공식 가격표로 재확인 필요)
  const cost = (usage.inTok * 1 + usage.outTok * 5) / 1_000_000;
  const md = [
    '# 실제 API 라이브 평가(자동 생성, 합성 이미지)',
    '',
    `호출 ${usage.calls}회(실패 ${usage.fails}), 입력 ${usage.inTok} / 출력 ${usage.outTok} 토큰, 평균 지연 ${avg(usage.latencies).toFixed(0)}ms (p95 ${p95(usage.latencies)}ms), 추정 비용 약 $${cost.toFixed(4)} [가정: Haiku 4.5 $1/$5 per M].`,
    '',
    '| 쌍 | 정답 | 모드 | 설명 | 사진 점수(AI → 색규칙 후) | 총점 | 등급 | 추출 속성(카테고리/색/브랜드) | 민감 감지 | AI 근거 |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...rows,
  ].join('\n');
  console.log(md);
  writeFileSync(fileURLToPath(new URL(only.length ? './LIVE-RESULTS-COLOR.generated.md' : './LIVE-RESULTS.generated.md', import.meta.url)), md + '\n');
}

main().catch((e) => {
  console.error('라이브 평가 실패:', e instanceof Error ? e.name : e); // 메시지 노출 방지
  process.exitCode = 1;
});
