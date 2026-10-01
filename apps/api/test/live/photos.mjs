// 라이브 시나리오용 합성 사진 생성기(sharp + SVG). 저작권·개인정보 문제가 없도록 전부 직접 그린 가짜 물건이다.
// - 학생증은 "FAKE" 이름·번호(0000-…)만 쓴다. 한글 글꼴이 없는 서버에서도 깨지지 않게 영문/숫자만 사용한다.
// - 같은 물건의 "실제 일치" 쌍은 같은 그림을 배경·기울기·밝기만 바꿔 만든다(variant).
import sharp from 'sharp';

const W = 800;
const H = 600;

/** 배경: 책상/바닥 느낌의 그라디언트 + 은은한 줄무늬 */
function background(color1, color2) {
  return `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${color1}"/><stop offset="1" stop-color="${color2}"/></linearGradient>
    <filter id="sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="6" dy="10" stdDeviation="9" flood-opacity="0.35"/></filter>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  ${Array.from({ length: 10 }, (_, i) => `<rect x="0" y="${i * 60 + 10}" width="${W}" height="2" fill="#000" opacity="0.04"/>`).join('')}`;
}

function wrap(body, { bg = ['#d9d4cc', '#b8b0a4'], rotate = 0, scale = 1 } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  ${background(bg[0], bg[1])}
  <g transform="translate(${W / 2} ${H / 2}) rotate(${rotate}) scale(${scale}) translate(${-W / 2} ${-H / 2})" filter="url(#sh)">${body}</g>
</svg>`;
}

const star = (cx, cy, r, color) => {
  const pts = Array.from({ length: 10 }, (_, i) => {
    const a = (Math.PI / 5) * i - Math.PI / 2;
    const rr = i % 2 === 0 ? r : r * 0.45;
    return `${(cx + rr * Math.cos(a)).toFixed(1)},${(cy + rr * Math.sin(a)).toFixed(1)}`;
  }).join(' ');
  return `<polygon points="${pts}" fill="${color}"/>`;
};

/** 검은색 이어폰 케이스: 윗면 별 스티커, 오른쪽 아래 모서리 흠집(실제 일치 쌍의 식별 특징) */
function earphoneCaseTrue(variant) {
  const body = `
    <rect x="270" y="190" width="260" height="210" rx="62" fill="#17171b"/>
    <rect x="270" y="190" width="260" height="210" rx="62" fill="url(#gl)" opacity="0.5"/>
    <defs><linearGradient id="gl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.35"/><stop offset="0.5" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>
    <path d="M272 285 H528" stroke="#050507" stroke-width="5"/>
    <rect x="375" y="266" width="50" height="14" rx="6" fill="#2b2b31"/>
    <circle cx="400" cy="345" r="7" fill="#37d67a"/>
    ${star(330, 238, 22, '#ffd54a')}
    <path d="M492 372 l22 -14 M498 384 l20 -12 M486 392 l22 -16" stroke="#e9e9ee" stroke-width="2.2" opacity="0.85"/>`;
  return wrap(body, variant);
}

/** 닮은 다른 물건: 같은 검은 케이스지만 모양(각진 모서리)·재질(무광 회색)·장식(고리+은색 로고)이 다르고 별 스티커가 없다 */
function earphoneCaseLookalike(variant) {
  const body = `
    <rect x="280" y="200" width="240" height="190" rx="26" fill="#2c2c30"/>
    <path d="M400 200 V390" stroke="#111" stroke-width="4"/>
    <circle cx="400" cy="296" r="26" fill="none" stroke="#c8c8d0" stroke-width="5"/>
    <circle cx="400" cy="296" r="9" fill="#c8c8d0"/>
    <circle cx="500" cy="372" r="18" fill="#1a1a1d" stroke="#555" stroke-width="3"/>
    <path d="M500 372 C560 420 520 470 470 440" stroke="#d22" stroke-width="7" fill="none"/>`;
  return wrap(body, variant);
}

/** 남색 우산(펼침): 흰 줄 한 칸, 나무 손잡이, 노란 이름표(리본) */
function umbrella(variant) {
  const ribs = Array.from({ length: 7 }, (_, i) => {
    const x = 160 + i * 80;
    return `<path d="M400 120 Q${x} 230 ${x} 300" stroke="#0e1636" stroke-width="3" fill="none"/>`;
  }).join('');
  const body = `
    <path d="M120 300 Q400 -30 680 300 Q640 270 600 300 Q560 270 520 300 Q480 270 440 300 Q400 270 360 300 Q320 270 280 300 Q240 270 200 300 Q160 270 120 300 Z" fill="#1e2a5e"/>
    <path d="M360 300 Q345 150 400 118 Q455 150 440 300 Q420 272 400 300 Q380 272 360 300 Z" fill="#f2f2f2" opacity="0.92"/>
    ${ribs}
    <rect x="394" y="300" width="12" height="150" fill="#9a9aa0"/>
    <path d="M400 450 Q400 505 350 505 Q315 505 315 470" stroke="#8a5a2b" stroke-width="22" stroke-linecap="round" fill="none"/>
    <rect x="404" y="330" width="26" height="40" rx="4" fill="#ffd54a"/>
    <circle cx="400" cy="118" r="7" fill="#0e1636"/>`;
  return wrap(body, variant);
}

/** 파란 물병 */
function bottle(variant) {
  const body = `
    <rect x="352" y="130" width="96" height="46" rx="12" fill="#e8e8ee"/>
    <rect x="368" y="176" width="64" height="30" fill="#2b6fd6"/>
    <path d="M345 215 Q345 195 368 205 H432 Q455 195 455 215 V440 Q455 475 420 475 H380 Q345 475 345 440 Z" fill="#2b6fd6"/>
    <rect x="345" y="290" width="110" height="80" fill="#fff" opacity="0.9"/>
    <circle cx="400" cy="330" r="22" fill="#e53935"/>
    <path d="M360 230 V430" stroke="#fff" stroke-width="6" opacity="0.25"/>`;
  return wrap(body, variant);
}

/** 갈색 지갑 */
function wallet(variant) {
  const body = `
    <rect x="250" y="210" width="300" height="190" rx="22" fill="#6b3e1d"/>
    <rect x="250" y="210" width="300" height="70" rx="22" fill="#7a4a26"/>
    <path d="M262 232 H538 M262 388 H538" stroke="#d9b48a" stroke-width="2.5" stroke-dasharray="7 6"/>
    <rect x="500" y="266" width="64" height="40" rx="12" fill="#c9a24a"/>
    <circle cx="532" cy="286" r="7" fill="#6b3e1d"/>`;
  return wrap(body, variant);
}

/** 가짜 학생증(민감 정보 이미지 시뮬레이션): 이름·번호는 모두 FAKE/0000 */
function fakeStudentId(variant) {
  const bars = Array.from({ length: 34 }, (_, i) => `<rect x="${300 + i * 6}" y="372" width="${i % 3 === 0 ? 4 : 2}" height="36" fill="#222"/>`).join('');
  const body = `
    <rect x="240" y="160" width="320" height="260" rx="18" fill="#fdfdfd" stroke="#bbb" stroke-width="2"/>
    <rect x="240" y="160" width="320" height="52" rx="18" fill="#1a4fa0"/>
    <rect x="240" y="196" width="320" height="16" fill="#1a4fa0"/>
    <text x="400" y="195" font-family="Arial, Helvetica, sans-serif" font-size="20" font-weight="bold" fill="#fff" text-anchor="middle">FAKE UNIVERSITY</text>
    <rect x="262" y="230" width="92" height="112" fill="#d6dbe6"/>
    <circle cx="308" cy="268" r="22" fill="#9aa3b5"/>
    <path d="M268 342 Q308 288 348 342 Z" fill="#9aa3b5"/>
    <text x="372" y="258" font-family="Arial, Helvetica, sans-serif" font-size="16" fill="#222">STUDENT ID</text>
    <text x="372" y="288" font-family="Arial, Helvetica, sans-serif" font-size="15" fill="#222">NAME: HONG GILDONG</text>
    <text x="372" y="312" font-family="Arial, Helvetica, sans-serif" font-size="15" fill="#222">(FAKE SAMPLE)</text>
    <text x="372" y="338" font-family="Arial, Helvetica, sans-serif" font-size="15" fill="#222">NO: 0000-0000-0000</text>
    ${bars}`;
  return wrap(body, variant);
}

const DRAWERS = { earphoneCaseTrue, earphoneCaseLookalike, umbrella, bottle, wallet, fakeStudentId };

/** kind: DRAWERS 키, variant: { bg, rotate, scale } → JPEG Buffer */
export async function makePhoto(kind, variant = {}) {
  const draw = DRAWERS[kind];
  if (!draw) throw new Error(`알 수 없는 사진 종류: ${kind}`);
  const svg = draw(variant);
  return sharp(Buffer.from(svg)).jpeg({ quality: 86 }).toBuffer();
}

export const PHOTO_KINDS = Object.keys(DRAWERS);
