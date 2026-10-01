import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { assertImageSendable, base64ByteLength, ImageError, prepareImageForAi } from '../image.js';
import { loadMatchingConfig } from '../weights.js';

const cfg = loadMatchingConfig({}).image;

describe('이미지 준비', () => {
  it('큰 이미지를 긴 변 1024px JPEG로 줄이고 EXIF를 제거한다', async () => {
    const src = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#445566' } })
      .withExif({ IFD0: { Copyright: 'secret-owner' } })
      .jpeg()
      .toBuffer();
    expect((await sharp(src).metadata()).exif).toBeDefined();
    const out = await prepareImageForAi(src, cfg);
    expect(out.mediaType).toBe('image/jpeg');
    expect(Math.max(out.width, out.height)).toBe(1024);
    const buf = Buffer.from(out.base64, 'base64');
    expect((await sharp(buf).metadata()).exif).toBeUndefined();
    expect(buf.toString('latin1')).not.toContain('secret-owner');
    expect(() => assertImageSendable(out.base64, out.mediaType, cfg)).not.toThrow();
  });
  it('작은 이미지는 확대하지 않는다', async () => {
    const src = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#ffffff' } }).png().toBuffer();
    expect((await prepareImageForAi(src, cfg)).width).toBe(200);
  });
  it('이미지가 아니거나 비어 있거나 원본이 10MB 초과면 ImageError', async () => {
    await expect(prepareImageForAi(Buffer.from('not an image'), cfg)).rejects.toBeInstanceOf(ImageError);
    await expect(prepareImageForAi(new Uint8Array(0), cfg)).rejects.toBeInstanceOf(ImageError);
    await expect(prepareImageForAi(new Uint8Array(cfg.maxInputBytes + 1), cfg)).rejects.toBeInstanceOf(ImageError);
  });
  it('base64 길이 계산', () => {
    expect(base64ByteLength('QUJD')).toBe(3);
    expect(base64ByteLength('QQ==')).toBe(1);
    expect(base64ByteLength('')).toBe(0);
  });
});
