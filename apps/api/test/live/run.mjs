// 실제 Claude API 로 매칭을 검증하는 라이브 시나리오(HTTP 만 사용, UI 없음).
//
// 이 스크립트는 ANTHROPIC_API_KEY 를 읽지도 필요로 하지도 않는다. 키는 "서버(API 프로세스)" 환경 변수에만 있고,
// 여기서는 평범한 사용자처럼 API 를 호출해 결과(등급·레벨·AI 근거·지연)를 관찰한다.
//
// 사용:
//   node run.mjs --dry-run                     # 계획·예상 Claude 호출 수만 출력(네트워크 호출 없음, 확인 플래그 불필요)
//   LIVE_CONFIRM=1 API_URL=http://localhost:4000 node run.mjs
// 환경 변수(선택):
//   API_URL(기본 http://localhost:4000)  ORIGIN(기본 API_URL 의 origin; 서버 ALLOWED_ORIGINS 와 일치해야 함)
//   LIVE_TIMEOUT_S(글당 매칭 대기, 기본 120)  LIVE_CLEANUP=1(끝에 글 닫기+계정 삭제)
//   LIVE_SENSITIVE=1(민감 사진 확인 항목을 PASS/FAIL 로 판정; 기본은 정보만 출력)
//   LIVE_SAVE_PHOTOS=dir(생성한 사진을 저장해 눈으로 확인)  LIVE_PASSWORD(테스트 계정 비밀번호)
import { mkdirSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { makePhoto } from './photos.mjs';

// ─────────────────────────── 시나리오 정의 ───────────────────────────
// 사용자: A(분실자), B(습득자1), C(습득자2 + 사진 없는 분실글). 위치는 시드된 건물명(부분 일치)으로 찾는다.
const T = { earphone: ['이어폰', '검정'], umbrella: ['우산', '남색'], bottle: ['물병', '파랑'], wallet: ['지갑', '갈색'], idcard: ['학생증'] };

/** 사진이 있는 글만 Claude 호출을 일으킨다. photo: [종류, variant] | null */
const POSTS = [
  // key, user, type, title, desc, building, floor, tags, photo, (FOUND) storagePlace
  { key: 'A-earphone', user: 'A', type: 'LOST', title: '검은색 이어폰 케이스를 잃어버렸어요', desc: '검은색 이어폰 충전 케이스입니다. 윗면에 노란 별 스티커가 붙어 있고 오른쪽 아래 모서리에 긁힌 자국이 있어요.', building: '학생회관', floor: 1, tags: T.earphone, photo: ['earphoneCaseTrue', { bg: ['#d9d4cc', '#b8b0a4'] }] },
  { key: 'A-umbrella', user: 'A', type: 'LOST', title: '남색 장우산 분실', desc: '남색 우산이고 가운데 흰 줄 한 칸, 나무 손잡이, 노란 이름표가 달려 있어요.', building: '도서관', floor: 1, tags: T.umbrella, photo: ['umbrella', { bg: ['#cfd6cf', '#aab3aa'] }] },
  { key: 'A-bottle', user: 'A', type: 'LOST', title: '파란색 텀블러 분실', desc: '파란색 물병이고 흰 라벨에 빨간 동그라미 로고가 있어요.', building: '자연과학관', floor: 1, tags: T.bottle, photo: ['bottle', {}] },
  { key: 'C-earphone-nophoto', user: 'C', type: 'LOST', title: '검은 이어폰 케이스 분실(사진 없음)', desc: '검은색 이어폰 케이스를 학생회관 근처에서 잃어버렸어요. 사진은 없어요.', building: '학생회관', floor: 1, tags: T.earphone, photo: null },
  // 습득글
  { key: 'B-earphone-true', user: 'B', type: 'FOUND', title: '검은 케이스 주웠어요', desc: '학생회관 2층 복도에서 검은색 케이스를 주웠습니다. 윗면에 별 스티커가 있어요.', building: '학생회관', floor: 2, tags: T.earphone, photo: ['earphoneCaseTrue', { bg: ['#c8d0c4', '#9aa597'], rotate: -5, scale: 1.05 }], storage: '습득자 본인 소지' },
  { key: 'B-earphone-lookalike', user: 'B', type: 'FOUND', title: '검은색 이어폰 케이스 습득', desc: '학생회관에서 검은색 이어폰 케이스를 발견했습니다. 은색 고리와 빨간 끈이 달려 있어요.', building: '학생회관', floor: 1, tags: T.earphone, photo: ['earphoneCaseLookalike', { bg: ['#d6cfc4', '#b5ab9c'] }], storage: '학생회관 안내데스크' },
  { key: 'C-umbrella-true', user: 'C', type: 'FOUND', title: '남색 우산 주웠습니다', desc: '도서관 앞에서 남색 우산을 주웠어요. 나무 손잡이에 노란 이름표가 달려 있습니다.', building: '도서관', floor: 1, tags: T.umbrella, photo: ['umbrella', { bg: ['#d8d0c0', '#b4aa96'], rotate: 4, scale: 0.95 }], storage: '도서관 분실물함' },
  { key: 'B-wallet-nonmatch', user: 'B', type: 'FOUND', title: '갈색 지갑 습득', desc: '자연과학관 1층에서 갈색 가죽 지갑을 주웠어요.', building: '자연과학관', floor: 1, tags: T.wallet, photo: ['wallet', {}], storage: '자연과학관 행정실' },
  { key: 'B-umbrella-nophoto', user: 'B', type: 'FOUND', title: '남색 우산 습득(사진 없음)', desc: '도서관 1층에서 남색 우산을 주웠어요. 사진은 못 찍었습니다.', building: '도서관', floor: 1, tags: T.umbrella, photo: null, storage: '도서관 안내데스크' },
  { key: 'B-idcard-sensitive', user: 'B', type: 'FOUND', title: '학생증을 주웠습니다', desc: '학생회관 1층에서 학생증을 주웠어요. 본인 확인 후 돌려드릴게요.', building: '학생회관', floor: 1, tags: T.idcard, photo: ['fakeStudentId', {}], storage: '학생회관 안내데스크' },
];

/**
 * 기대 결과. 검사 대상은 "분실글 작성자가 보는 후보 목록"과 "습득글 작성자가 보는 후보 목록".
 *  - AI 가 정상일 때의 기대값이다. AI 키가 없거나 호출이 실패하면(degraded) AUTO 가 CANDIDATE 로 강등되므로 WARN 으로 표시한다.
 *  - kind: 'mustAuto'(HIGH/AUTO 기대) | 'notAuto'(AUTO 면 오탐) | 'none'(후보에 없어야 함) | 'candidateOrNone'(사진 없는 쌍: 일반적으로 로컬 점수가 낮아 AUTO 가 아니지만, 서버 기본값 NOPHOTO_AUTO_NOTIFY=true 에서는 AUTO 도 정책상 가능 → AUTO 면 FAIL 이 아니라 WARN)
 */
const EXPECTATIONS = [
  { id: 'S1 실제 일치(이어폰, 사진+위치+태그)', lost: 'A-earphone', found: 'B-earphone-true', kind: 'mustAuto' },
  { id: 'S2 닮은 다른 물건(이어폰)', lost: 'A-earphone', found: 'B-earphone-lookalike', kind: 'notAuto', rankBelow: 'B-earphone-true' },
  { id: 'S3 실제 일치(우산)', lost: 'A-umbrella', found: 'C-umbrella-true', kind: 'mustAuto' },
  { id: 'S4 비일치(다른 물건·다른 건물)', lost: 'A-bottle', found: 'B-wallet-nonmatch', kind: 'none' },
  { id: 'S5a 사진 없는 분실글 × 실제 일치 습득글', lost: 'C-earphone-nophoto', found: 'B-earphone-true', kind: 'candidateOrNone' },
  { id: 'S5b 사진 없는 분실글 × 닮은 습득글', lost: 'C-earphone-nophoto', found: 'B-earphone-lookalike', kind: 'candidateOrNone' },
  { id: 'S5c 사진 없는 습득글 × 우산 분실글', lost: 'A-umbrella', found: 'B-umbrella-nophoto', kind: 'candidateOrNone' },
];

// ─────────────────────────── 안전장치: Claude 호출 상한 ───────────────────────────
const MAX_REAL_CALLS = 60; // 하드 상한(예상 최악 호출 수가 넘으면 실행하지 않는다)
const MAX_PHOTO_POSTS = 12; // 사진 포함 글 수 하드 상한
const TOP_N = 5; // 서버 기본 MATCH_TOP_N(글당 AI 직접 비교 후보 상한). 서버 설정이 더 크면 추정이 어긋날 수 있다.

function estimateCalls() {
  const photoPosts = POSTS.filter((p) => p.photo);
  // 추출(속성) 호출: 사진 포함 글 1건당 1회(캐시되므로 이후 재사용)
  const extraction = photoPosts.length;
  // 직접 비교 호출: 글을 만들 때 "그 시점에 이미 있는 반대 유형 사진 글" 중 상위 TOP_N 과 비교(둘 다 사진이 있을 때만)
  let comparisons = 0;
  const seen = [];
  for (const p of POSTS) {
    if (p.photo) comparisons += Math.min(TOP_N, seen.filter((q) => q.type !== p.type).length);
    seen.push(...(p.photo ? [p] : []));
  }
  // 최악: DB 에 이미 있던 반대 유형 사진 글(이전 실행·시연 데이터)이 많아 글마다 TOP_N 번 비교하는 경우
  const worst = extraction + photoPosts.length * TOP_N;
  return { photoPosts: photoPosts.length, extraction, comparisons, expected: extraction + comparisons, worst };
}

const est = estimateCalls();
console.log('── KUnnect 라이브 매칭 시나리오 ──');
console.log(`글 ${POSTS.length}건 (사진 포함 ${est.photoPosts}건, 상한 ${MAX_PHOTO_POSTS}) / 사용자 3명`);
console.log(`예상 Claude 호출: 속성 추출 ${est.extraction} + 직접 비교 ≈${est.comparisons} = 약 ${est.expected}회`);
console.log(`최악(기존 데이터와 비교 상한 ${TOP_N}회/글까지 가정): ${est.worst}회  (하드 상한 ${MAX_REAL_CALLS})`);
if (est.photoPosts > MAX_PHOTO_POSTS || est.worst > MAX_REAL_CALLS) {
  console.error(`중단: 호출 상한을 넘습니다(사진 글 ${est.photoPosts}/${MAX_PHOTO_POSTS}, 최악 ${est.worst}/${MAX_REAL_CALLS}). 시나리오를 줄이세요.`);
  process.exit(2);
}
console.log('권장: 서버를 AI_DAILY_CALL_LIMIT=60 으로 띄우면 서버 쪽에서도 상한이 걸립니다(재시도 포함 실제 HTTP 호출 기준).');

if (process.argv.includes('--dry-run')) {
  console.log('\n[dry-run] 사진만 생성해 크기를 확인하고 종료합니다(네트워크 호출 없음).');
  for (const p of POSTS.filter((x) => x.photo)) {
    const buf = await makePhoto(...p.photo);
    console.log(`  - ${p.key}: ${p.photo[0]} ${(buf.length / 1024).toFixed(0)}KB`);
  }
  process.exit(0);
}
if (process.env.LIVE_CONFIRM !== '1') {
  console.error('\n실제 Claude API 비용이 발생할 수 있습니다. 위 호출 수를 확인했다면 LIVE_CONFIRM=1 로 다시 실행하세요.');
  process.exit(2);
}

// ─────────────────────────── HTTP 도우미 ───────────────────────────
const API_URL = (process.env.API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const ORIGIN = process.env.ORIGIN ?? new URL(API_URL).origin;
const BASE = `${API_URL}/api/v1`;
const TIMEOUT_MS = Number(process.env.LIVE_TIMEOUT_S ?? 120) * 1000;
const PASSWORD = process.env.LIVE_PASSWORD ?? 'Live-Pass-2026!';
const stamp = Date.now().toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Api {
  constructor(name) {
    this.name = name;
    this.cookie = null;
    this.id = null;
  }
  async call(method, path, { body, form, expect } = {}) {
    const headers = { Origin: ORIGIN };
    if (this.cookie) headers.cookie = this.cookie;
    let payload;
    if (form) payload = form;
    else if (method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body ?? {});
    }
    const res = await fetch(`${BASE}${path}`, { method, headers, body: payload });
    const sc = res.headers.get('set-cookie');
    if (sc && sc.startsWith('kunnect_sid=')) this.cookie = sc.split(';')[0];
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* 본문이 JSON 이 아님 */
    }
    if (expect && !expect.includes(res.status)) {
      throw new Error(`${this.name} ${method} ${path} → ${res.status} ${json?.error?.code ?? ''} ${json?.error?.message ?? text.slice(0, 120)}`);
    }
    return { status: res.status, json, headers: res.headers };
  }
}

const users = { A: new Api('A'), B: new Api('B'), C: new Api('C') };
const redact = (s) => (s ?? '').replace(/[0-9]/g, '#').replace(/\S+@\S+/g, '<email>');

// ─────────────────────────── 1) 가입/로그인 ───────────────────────────
console.log('\n[1/5] 사용자 가입·로그인');
for (const [k, u] of Object.entries(users)) {
  const loginId = `live_${k.toLowerCase()}_${stamp}`;
  const su = await u.call('POST', '/auth/signup', { body: { loginId, password: PASSWORD, nickname: `라이브${k}${stamp.slice(-3)}` }, expect: [201, 409, 429] });
  if (su.status === 429) throw new Error('가입 제한(429): 같은 IP 에서 시간당 5명. 잠시 후 다시 하거나 서버를 NODE_ENV=test 로 띄우세요.');
  await u.call('POST', '/auth/login', { body: { loginId, password: PASSWORD }, expect: [200] });
  const me = (await u.call('GET', '/me', { expect: [200] })).json;
  u.id = me.id;
  u.loginId = loginId;
  console.log(`  ${k}: ${loginId} (id ${me.id})`);
}

// 위치/태그 조회
const locations = (await users.A.call('GET', '/locations', { expect: [200] })).json.items;
function findLocation(building, floor) {
  const hit = locations.find((l) => l.buildingName.includes(building) && l.floor === floor) ?? locations.find((l) => l.buildingName.includes(building));
  if (!hit) throw new Error(`위치를 찾을 수 없습니다: ${building} ${floor}층 (시드 확인: pnpm db:seed)`);
  return hit;
}

// ─────────────────────────── 2) 글 작성 + 매칭 대기 ───────────────────────────
console.log('\n[2/5] 글 작성 및 매칭 완료 대기 (글마다 순차 실행, 지연 측정)');
if (process.env.LIVE_SAVE_PHOTOS) mkdirSync(process.env.LIVE_SAVE_PHOTOS, { recursive: true });
const created = {}; // key → { id, photoUrl, latencyMs, matchState }
const keyById = {};
const photoBytes = {};

for (const p of POSTS) {
  const u = users[p.user];
  const loc = findLocation(p.building, p.floor);
  let photoIds = [];
  if (p.photo) {
    const buf = await makePhoto(...p.photo);
    photoBytes[p.key] = buf;
    if (process.env.LIVE_SAVE_PHOTOS) writeFileSync(`${process.env.LIVE_SAVE_PHOTOS}/${p.key}.jpg`, buf);
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: 'image/jpeg' }), `${p.key}.jpg`);
    const up = await u.call('POST', '/photos', { form: fd, expect: [201] });
    photoIds = [up.json.photoId];
  }
  const occurred = new Date(Date.now() - (p.type === 'LOST' ? 3 : 2) * 3600_000).toISOString();
  const t0 = performance.now();
  const post = (
    await u.call('POST', '/posts', {
      body: { type: p.type, title: p.title, description: p.desc, locationId: loc.id, occurredAt: occurred, tags: p.tags, photoIds, ...(p.type === 'FOUND' ? { storagePlace: p.storage } : {}) },
      expect: [201],
    })
  ).json;
  const id = post.id;
  let state = post.matchState;
  const deadline = Date.now() + TIMEOUT_MS;
  while (state === 'PENDING' && Date.now() < deadline) {
    await sleep(1000);
    state = (await u.call('GET', `/posts/${id}`, { expect: [200] })).json.matchState;
  }
  const latency = Math.round(performance.now() - t0);
  created[p.key] = { id, matchState: state, latencyMs: latency, photoUrl: post.photos?.[0]?.url ?? null, user: p.user, type: p.type };
  keyById[id] = p.key;
  console.log(`  ${p.key.padEnd(24)} #${id}  ${p.photo ? '사진' : '    '}  matchState=${state}  ${(latency / 1000).toFixed(1)}s`);
  if (state === 'PENDING') console.warn(`  ⚠ ${p.key}: ${TIMEOUT_MS / 1000}s 안에 끝나지 않음(서버 로그 확인)`);
}

// ─────────────────────────── 3) 후보·알림 수집 ───────────────────────────
console.log('\n[3/5] 후보(matches)·알림 수집');
const matchLists = {};
for (const p of POSTS) {
  const r = await users[p.user].call('GET', `/posts/${created[p.key].id}/matches`, { expect: [200] });
  matchLists[p.key] = r.json.items.map((m) => ({ otherKey: keyById[m.otherPost.id] ?? `#${m.otherPost.id}`, level: m.level, grade: m.grade, locationDiff: m.locationDiff, aiReason: m.aiReason, status: m.status }));
}
const notifications = {};
for (const [k, u] of Object.entries(users)) {
  notifications[k] = (await u.call('GET', '/notifications?limit=50', { expect: [200] })).json.items.filter((n) => n.type === 'MATCH');
}

// ─────────────────────────── 4) 판정 표 ───────────────────────────
function find(listKey, otherKey) {
  return (matchLists[listKey] ?? []).find((m) => m.otherKey === otherKey) ?? null;
}
// AI 가 한 번이라도 근거(aiReason)를 남겼는지: 없으면 로컬 점수(위치·태그)만 반영된 degraded 실행으로 본다
const anyAi = Object.values(matchLists).some((list) => list.some((m) => m.aiReason));
const verdicts = [];
for (const e of EXPECTATIONS) {
  const m = find(e.lost, e.found);
  const rev = find(e.found, e.lost);
  const aiUsed = Boolean(m?.aiReason) || Boolean(rev?.aiReason);
  let verdict;
  let note = '';
  if (e.kind === 'mustAuto') {
    if (m?.level === 'AUTO' && m.grade === 'HIGH') verdict = 'PASS';
    else if (m) { verdict = 'WARN'; note = aiUsed ? 'AI 사용했으나 AUTO/HIGH 미달' : 'AUTO 미달(degraded 가능: 키 없음/상한/호출 실패)'; }
    else { verdict = 'FAIL'; note = '후보에 없음(미탐)'; }
  } else if (e.kind === 'notAuto') {
    if (m?.level === 'AUTO') { verdict = 'FAIL'; note = '오탐: 닮은 물건이 AUTO'; }
    else {
      verdict = 'PASS';
      if (e.rankBelow) {
        const order = (matchLists[e.lost] ?? []).map((x) => x.otherKey);
        if (m && order.indexOf(e.rankBelow) > order.indexOf(e.found)) {
          // AI 없이는 사진 비교가 없어 위치·태그만으로 순위가 정해진다 → 실패가 아니라 경고(실행 조건 문제)
          verdict = anyAi ? 'FAIL' : 'WARN';
          note = anyAi ? '순위 오류: 닮은 물건이 실제 일치보다 위' : '순위 역전(AI 근거 없음: degraded 실행이라 사진 비교가 반영되지 않음)';
        }
      }
    }
  } else if (e.kind === 'none') {
    verdict = m || rev ? 'FAIL' : 'PASS';
    if (m || rev) note = '오탐: 비일치가 후보에 나타남';
  } else {
    // [사용자 결정] 사진 없는 글에 별도 정책 없음 → 기본 NOPHOTO_AUTO_NOTIFY=true: 일반 AUTO 규칙(사진 없음 임계 0.85)을 따른다.
    // 따라서 AUTO 는 오류가 아니라 점검 대상이다(WARN). AUTO 를 막으려면 서버 환경 변수 NOPHOTO_AUTO_NOTIFY=false.
    verdict = m?.level === 'AUTO' || rev?.level === 'AUTO' ? 'WARN' : 'PASS';
    if (verdict === 'WARN') note = '사진 없는 매칭이 AUTO 로 승격됨(NOPHOTO_AUTO_NOTIFY=true 기본에서는 정책상 가능, 오탐 여부 확인 필요. 막으려면 NOPHOTO_AUTO_NOTIFY=false)';
    else note = '사진 없는 매칭: AUTO 아님(로컬 점수가 임계 미만)';
  }
  verdicts.push({ id: e.id, expected: e.kind, actual: m ? `${m.level}/${m.grade}/${m.locationDiff}` : '(없음)', reverse: rev ? `${rev.level}/${rev.grade}` : '(없음)', aiReason: redact(m?.aiReason ?? rev?.aiReason ?? ''), verdict, note });
}

console.log('\n[4/5] 기대 vs 실제');
console.log('| 시나리오 | 기대 | 실제(분실자 시점: 레벨/등급/위치) | 반대 시점 | 판정 | 비고 |');
console.log('|---|---|---|---|---|---|');
for (const v of verdicts) console.log(`| ${v.id} | ${v.expected} | ${v.actual} | ${v.reverse} | **${v.verdict}** | ${v.note} |`);
console.log('\nAI 근거(숫자 가림):');
for (const v of verdicts.filter((x) => x.aiReason)) console.log(`- ${v.id}: ${v.aiReason}`);

console.log('\n글별 지연(생성 → 매칭 완료):');
console.log('| 글 | 사진 | matchState | 지연(s) | 후보 수 |');
console.log('|---|---|---|---|---|');
for (const p of POSTS) console.log(`| ${p.key} | ${p.photo ? 'O' : '-'} | ${created[p.key].matchState} | ${(created[p.key].latencyMs / 1000).toFixed(1)} | ${matchLists[p.key].length} |`);
const lat = POSTS.filter((p) => p.photo).map((p) => created[p.key].latencyMs).sort((a, b) => a - b);
if (lat.length) console.log(`사진 글 지연 p50 ${(lat[Math.floor(lat.length / 2)] / 1000).toFixed(1)}s, max ${(lat[lat.length - 1] / 1000).toFixed(1)}s`);
console.log('\nMATCH 알림(분실자에게만 발송, AUTO 에서 1회):');
for (const [k, list] of Object.entries(notifications)) console.log(`  ${k}: ${list.length}건`);
const autoCount = verdicts.filter((v) => v.actual.startsWith('AUTO')).length;
const notifTotal = Object.values(notifications).reduce((n, l) => n + l.length, 0);
console.log(`  AUTO 매칭 ${autoCount}건 ↔ MATCH 알림 ${notifTotal}건 ${autoCount === 0 && notifTotal === 0 ? '(AUTO 없음: AI 미사용/degraded 일 수 있음)' : ''}`);

// ─────────────────────────── 5) 민감 사진 점검 ───────────────────────────
// 학생증 같은 민감 사진: 작성자는 원본, 다른 사용자는 흐림 사본(원본 URL 은 404, 비로그인은 401). 구현: dev-plan 17절.
console.log('\n[5/5] 민감 사진 점검 (학생증 가짜 이미지)');
async function sharpness(buf) {
  // 선명도 지표: 원본과 가우시안 블러본의 평균 절대차(블러된 이미지는 차이가 작다)
  const { data } = await sharp(buf).greyscale().resize(400).raw().toBuffer({ resolveWithObject: true });
  const blurred = await sharp(buf).greyscale().resize(400).blur(2).raw().toBuffer();
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += Math.abs(data[i] - blurred[i]);
  return sum / data.length;
}
const sens = created['B-idcard-sensitive'];
let sensitiveVerdict = 'INFO';
if (!sens?.photoUrl) {
  console.log('  사진 URL 을 받지 못해 건너뜀');
} else {
  const fetchAs = async (u) => {
    const res = await fetch(new URL(sens.photoUrl, API_URL).toString(), { headers: { ...(u?.cookie ? { cookie: u.cookie } : {}), Origin: ORIGIN } });
    return { status: res.status, type: res.headers.get('content-type'), buf: res.status === 200 ? Buffer.from(await res.arrayBuffer()) : null };
  };
  const [author, other, anon] = [await fetchAs(users.B), await fetchAs(users.A), await fetchAs(null)];
  const report = async (label, r) => {
    if (!r.buf) return console.log(`  ${label}: HTTP ${r.status} (이미지 없음)`);
    return console.log(`  ${label}: HTTP ${r.status} ${r.type} ${(r.buf.length / 1024).toFixed(0)}KB 선명도 ${(await sharpness(r.buf)).toFixed(2)}`);
  };
  await report('작성자(B) 원본 URL', author);
  await report('비작성자(A, 로그인) 원본 URL', other);
  await report('비로그인 원본 URL', anon);
  // 비작성자가 글 상세에서 받는 사진 URL(흐림 사본 URL 이어야 한다)을 따로 가져온다
  const seenByA = (await users.A.call('GET', `/posts/${sens.id}`, { expect: [200] })).json.photos?.[0];
  console.log(`  비작성자(A)가 받은 사진 정보: isBlurred=${seenByA?.isBlurred} sensitive=${seenByA?.sensitive} url=${seenByA?.url ? new URL(seenByA.url, API_URL).pathname.replace(/[0-9a-f]{32}/, '<id>') : null}`);
  let blurredCopy = { status: 'N/A', buf: null };
  if (seenByA?.url) {
    const res = await fetch(new URL(seenByA.url, API_URL).toString(), { headers: { cookie: users.A.cookie, Origin: ORIGIN } });
    blurredCopy = { status: res.status, type: res.headers.get('content-type'), buf: res.status === 200 ? Buffer.from(await res.arrayBuffer()) : null };
  }
  await report('비작성자(A) 흐림 사본 URL', blurredCopy);
  const originalHidden = other.status !== 200 && anon.status !== 200;
  let ratio = null;
  if (author.buf && blurredCopy.buf) ratio = (await sharpness(blurredCopy.buf)) / (await sharpness(author.buf));
  const looksBlurred = ratio !== null && ratio < 0.6;
  console.log(`  원본 비공개(비작성자·비로그인 non-200): ${originalHidden} / 흐림 사본 200: ${blurredCopy.status === 200} / 흐림 사본÷원본 선명도 비: ${ratio === null ? 'N/A' : ratio.toFixed(2)} → ${looksBlurred ? '흐리게 처리된 것으로 보임' : '흐림 확인 안 됨'}`);
  if (process.env.LIVE_SENSITIVE === '1') {
    sensitiveVerdict = originalHidden && blurredCopy.status === 200 && looksBlurred ? 'PASS' : 'FAIL';
    console.log(`  판정(LIVE_SENSITIVE=1): ${sensitiveVerdict} — PASS 조건: 비작성자에게 원본 URL 은 non-200, 흐림 사본은 200 이고 눈에 띄게 흐릿함`);
  } else {
    console.log('  (정보용. 판정하려면 LIVE_SENSITIVE=1)');
  }
}

// ─────────────────────────── 요약 / 정리 ───────────────────────────
if (!anyAi) {
  console.log('\n⚠ 어떤 후보에도 AI 근거(aiReason)가 없습니다: 서버에 ANTHROPIC_API_KEY 가 없거나 호출이 실패해 degraded 로 동작했을 가능성이 큽니다. 이 실행은 스크립트 동작 확인용으로만 보세요.');
}
const summary = { pass: verdicts.filter((v) => v.verdict === 'PASS').length, warn: verdicts.filter((v) => v.verdict === 'WARN').length, fail: verdicts.filter((v) => v.verdict === 'FAIL').length };
console.log(`\n요약: PASS ${summary.pass} / WARN ${summary.warn} / FAIL ${summary.fail} (민감 사진 ${sensitiveVerdict})`);
mkdirSync(new URL('./out', import.meta.url), { recursive: true });
writeFileSync(new URL(`./out/live-${stamp}.json`, import.meta.url), JSON.stringify({ at: new Date().toISOString(), apiUrl: API_URL, estimate: est, created, verdicts, matchLists, summary }, null, 2));
console.log(`상세 결과: test/live/out/live-${stamp}.json`);

if (process.env.LIVE_CLEANUP === '1') {
  console.log('\n정리: 글 닫기 + 테스트 계정 삭제');
  for (const p of POSTS) await users[p.user].call('DELETE', `/posts/${created[p.key].id}`, { expect: [204, 404] }).catch((e) => console.warn(`  글 정리 실패: ${e.message}`));
  for (const [k, u] of Object.entries(users)) {
    const r = await u.call('DELETE', '/me', { body: { password: PASSWORD } }).catch((e) => ({ status: e.message }));
    console.log(`  계정 ${k} 삭제: ${r.status}`);
  }
  console.log('  (글은 CLOSED 처리되고 보존 기간 후 서버가 삭제합니다)');
}
process.exit(summary.fail > 0 ? 1 : 0);
