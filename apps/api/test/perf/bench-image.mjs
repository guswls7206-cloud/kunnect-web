// 사진 업로드 처리(sharp)의 단건 비용 측정: src/modules/photos/routes.ts 의 processImage 와 같은 파이프라인.
// mozjpeg 옵션·입력 종류별로 비교한다. 사용: node bench-image.mjs
import sharp from 'sharp';

const W = 1600, H = 1200;

// 1) 무작위 노이즈(압축이 가장 어려운 최악 케이스), 2) 완만한 그라디언트+약한 노이즈(일반 사진에 가까운 케이스)
const noise = Buffer.alloc(W * H * 3);
for (let i = 0; i < noise.length; i++) noise[i] = (Math.random() * 256) | 0;
const smooth = Buffer.alloc(W * H * 3);
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 3;
    const n = (Math.random() * 12) | 0;
    smooth[o] = ((x / W) * 200 + n) | 0;
    smooth[o + 1] = ((y / H) * 200 + n) | 0;
    smooth[o + 2] = (((x + y) / (W + H)) * 200 + n) | 0;
  }
const inputs = {
  '노이즈 1600x1200': await sharp(noise, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 85 }).toBuffer(),
  '완만한 이미지 1600x1200': await sharp(smooth, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 85 }).toBuffer(),
  '큰 사진 4000x3000(휴대폰급)': await sharp({ create: { width: 4000, height: 3000, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 30 } } }).jpeg({ quality: 85 }).toBuffer(),
};

async function run(input, mozjpeg, runs = 8) {
  const times = [];
  let size = 0;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    const out = await sharp(input, { failOn: 'error', limitInputPixels: 40_000_000 })
      .rotate()
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg })
      .toBuffer({ resolveWithObject: true });
    size = out.data.length;
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  return { p50: Math.round(times[Math.floor(runs / 2)]), min: Math.round(times[0]), max: Math.round(times[runs - 1]), kb: Math.round(size / 1024) };
}

console.log(`sharp ${sharp.versions.sharp}, libvips ${sharp.versions.vips}, 동시성 기본값 ${sharp.concurrency()}`);
for (const [name, buf] of Object.entries(inputs)) {
  const a = await run(buf, true);
  const b = await run(buf, false);
  console.log(`${name} (입력 ${(buf.length / 1024).toFixed(0)}KB): mozjpeg=true p50 ${a.p50}ms → ${a.kb}KB | mozjpeg=false p50 ${b.p50}ms → ${b.kb}KB (용량 ${(((b.kb - a.kb) / a.kb) * 100).toFixed(0)}%)`);
}
