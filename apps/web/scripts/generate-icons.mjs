// PWA 아이콘(PNG)을 외부 의존성 없이 생성한다: 브랜드색 배경 + 흰색 "K" 모양.
// 사용: node scripts/generate-icons.mjs  (결과는 public/ 에 저장되며 저장소에 커밋한다)
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const BRAND = [0x0b, 0x7a, 0x4b];
const WHITE = [255, 255, 255];

function crc32(buf) {
  let c,
    crc = ~0;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** 점 (x,y)가 선분 a-b 에서 half 이내인지 */
function nearSegment(x, y, ax, ay, bx, by, half) {
  const dx = bx - ax,
    dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy)) <= half;
}

function png(size, safeScale) {
  // safeScale: 글자 영역 비율(maskable은 안전 영역 때문에 작게)
  const c = size / 2;
  const h = (size * safeScale) / 2;
  const stroke = size * 0.07;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const stem = nearSegment(x, y, c - h * 0.55, c - h, c - h * 0.55, c + h, stroke / 2);
      const up = nearSegment(x, y, c - h * 0.55, c, c + h * 0.6, c - h, stroke / 2);
      const down = nearSegment(x, y, c - h * 0.55, c, c + h * 0.6, c + h, stroke / 2);
      const [r, g, b] = stem || up || down ? WHITE : BRAND;
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

writeFileSync("public/icon-192.png", png(192, 0.7));
writeFileSync("public/icon-512.png", png(512, 0.7));
writeFileSync("public/icon-maskable-512.png", png(512, 0.5));
writeFileSync("public/apple-touch-icon.png", png(180, 0.7));
console.log("아이콘 생성 완료");
