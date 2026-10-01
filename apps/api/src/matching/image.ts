/** AI 전송용 이미지 준비·검증. EXIF/GPS는 sharp 재인코딩으로 제거된다. */
import sharp from 'sharp';
import type { ImageMediaType } from './types.js';
import type { MatchingConfig } from './weights.js';

const ALLOWED: readonly ImageMediaType[] = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export class ImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageError';
  }
}

export interface PreparedImage {
  base64: string;
  mediaType: 'image/jpeg';
  bytes: number;
  width: number;
  height: number;
}

/**
 * 원본 → 긴 변 ≤ maxSide(기본 1024px) JPEG 사본(방향 보정 후 메타데이터 제거).
 * 원본이 maxInputBytes(10MB)를 넘거나 이미지가 아니면 ImageError.
 */
export async function prepareImageForAi(input: Uint8Array, cfg: MatchingConfig['image']): Promise<PreparedImage> {
  if (input.byteLength === 0) throw new ImageError('빈 이미지');
  if (input.byteLength > cfg.maxInputBytes) throw new ImageError('원본 이미지가 너무 큽니다');
  try {
    const { data, info } = await sharp(input, { failOn: 'error', limitInputPixels: 50_000_000 })
      .rotate()
      .resize({ width: cfg.maxSide, height: cfg.maxSide, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer({ resolveWithObject: true });
    if (data.byteLength > cfg.maxBytes) throw new ImageError('변환된 이미지가 허용 크기를 초과합니다');
    return {
      base64: data.toString('base64'),
      mediaType: 'image/jpeg',
      bytes: data.byteLength,
      width: info.width,
      height: info.height,
    };
  } catch (e) {
    if (e instanceof ImageError) throw e;
    throw new ImageError('이미지를 처리할 수 없습니다');
  }
}

/** base64 디코딩 후 바이트 수(문자열 전체를 디코딩하지 않고 계산) */
export function base64ByteLength(b64: string): number {
  const len = b64.length;
  if (len === 0) return 0;
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((len * 3) / 4) - pad;
}

/** 전송 전 검증: 허용 타입, 허용 크기, base64 형식. 위반 시 ImageError */
export function assertImageSendable(base64: string, mediaType: string, cfg: MatchingConfig['image']): void {
  if (!ALLOWED.includes(mediaType as ImageMediaType)) throw new ImageError(`지원하지 않는 이미지 형식: ${mediaType}`);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new ImageError('base64 형식이 올바르지 않습니다');
  if (base64ByteLength(base64) > cfg.maxBytes) throw new ImageError('이미지가 허용 크기를 초과합니다');
}

// ───────────── 개인정보 보호용 흐림 처리 ─────────────

export type BlurMode = 'BLUR' | 'PIXELATE';

/** 정규화 좌표(0~1) 영역. x,y = 왼쪽 위, w,h = 크기 */
export interface BlurRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BlurOptions {
  /** BLUR: 부드럽게 뭉갬(기본), PIXELATE: 모자이크 */
  mode?: BlurMode;
  /**
   * 일부 영역만 처리(예: 모델이 준 상자). 없거나 비어 있으면 **이미지 전체**를 처리한다(안전한 기본값).
   * 모델이 주는 상자는 정확도가 낮으므로 호출 측은 확신이 없으면 전체 처리를 쓰는 것이 안전하다.
   */
  regions?: BlurRegion[];
  /** 결과 이미지의 긴 변 상한(px). 기본 1024 */
  maxSide?: number;
  /**
   * 정보를 남기는 해상도(긴 변 기준 칸 수). 작을수록 강하다. 기본 32 —
   * 이 해상도에서는 글자·얼굴·카드 번호를 알아볼 수 없고 색·대략적 형태만 남는다. 4~128 로 제한.
   */
  cells?: number;
}

export interface BlurredImage {
  buffer: Buffer;
  mediaType: 'image/jpeg';
  width: number;
  height: number;
  /** 처리 범위: 'ALL' = 전체, 숫자 = 처리한 영역 수 */
  scope: 'ALL' | number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** 이미지를 cells 해상도로 줄였다가 원래 크기로 키워 원본 정보를 되돌릴 수 없게 파괴한다 */
async function destroyDetail(src: Buffer, width: number, height: number, cells: number, mode: BlurMode): Promise<Buffer> {
  const small = await sharp(src).resize({ width: cells, height: cells, fit: 'inside', withoutEnlargement: false }).raw().toBuffer({ resolveWithObject: true });
  const base = sharp(small.data, { raw: { width: small.info.width, height: small.info.height, channels: small.info.channels } });
  const big =
    mode === 'PIXELATE'
      ? base.resize({ width, height, fit: 'fill', kernel: 'nearest' })
      : base.resize({ width, height, fit: 'fill', kernel: 'cubic' }).blur(Math.max(1, Math.min(width, height) / 60));
  return big.jpeg({ quality: 70 }).toBuffer();
}

/**
 * 개인정보 보호용 이미지 처리. 기본은 이미지 전체를 강하게 뭉갠다(방향 보정 후 EXIF 등 메타데이터 제거, JPEG 재인코딩).
 * 단순 가우시안 블러가 아니라 해상도를 먼저 줄여 정보를 버리므로 역변환(디블러)으로 글자를 복원할 수 없다.
 * 입력이 이미지가 아니거나 너무 크면 ImageError — 호출 측은 **실패 시 원본을 쓰지 말고** 사진을 빼야 한다(fail-closed).
 */
export async function blurImageForPrivacy(input: Uint8Array, opts: BlurOptions = {}, limits: { maxInputBytes?: number } = {}): Promise<BlurredImage> {
  const maxInput = limits.maxInputBytes ?? 10 * 1024 * 1024;
  if (input.byteLength === 0) throw new ImageError('빈 이미지');
  if (input.byteLength > maxInput) throw new ImageError('원본 이미지가 너무 큽니다');
  const mode = opts.mode ?? 'BLUR';
  const cells = clamp(Math.round(opts.cells ?? 32), 4, 128);
  const maxSide = clamp(Math.round(opts.maxSide ?? 1024), 64, 4096);
  try {
    const { data, info } = await sharp(input, { failOn: 'error', limitInputPixels: 50_000_000 })
      .rotate()
      .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer({ resolveWithObject: true });
    const W = info.width;
    const H = info.height;

    const regions = (opts.regions ?? [])
      .filter((r) => [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w > 0 && r.h > 0)
      .map((r) => {
        // 모델 상자는 부정확하므로 사방 15% 여유를 두고 이미지 경계로 자른다
        const padX = r.w * 0.15;
        const padY = r.h * 0.15;
        const x0 = clamp(Math.floor((r.x - padX) * W), 0, W - 1);
        const y0 = clamp(Math.floor((r.y - padY) * H), 0, H - 1);
        const x1 = clamp(Math.ceil((r.x + r.w + padX) * W), x0 + 1, W);
        const y1 = clamp(Math.ceil((r.y + r.h + padY) * H), y0 + 1, H);
        return { left: x0, top: y0, width: x1 - x0, height: y1 - y0 };
      });

    let out: Buffer;
    let scope: BlurredImage['scope'];
    if (regions.length === 0) {
      out = await destroyDetail(data, W, H, cells, mode);
      scope = 'ALL';
    } else {
      const patches = await Promise.all(
        regions.map(async (g) => {
          const crop = await sharp(data).extract(g).jpeg({ quality: 90 }).toBuffer();
          // 영역 안에서도 칸 수를 영역 크기에 맞춰 제한해 글자가 남지 않게 한다
          const regionCells = clamp(Math.round((cells * Math.max(g.width, g.height)) / Math.max(W, H)), 3, cells);
          return { input: await destroyDetail(crop, g.width, g.height, regionCells, mode), left: g.left, top: g.top };
        }),
      );
      out = await sharp(data).composite(patches).jpeg({ quality: 85 }).toBuffer();
      scope = regions.length;
    }
    return { buffer: out, mediaType: 'image/jpeg', width: W, height: H, scope };
  } catch (e) {
    if (e instanceof ImageError) throw e;
    throw new ImageError('이미지를 처리할 수 없습니다');
  }
}
