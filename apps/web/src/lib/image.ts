/** 업로드 전 사진 압축에 쓰는 최대 긴 변(px). 서버도 1600px로 줄이므로 그보다 작게 맞춘다. */
export const MAX_EDGE = 1280;
const JPEG_QUALITY = 0.85;
/** 서버가 받는 형식(JPEG/PNG/WebP). HEIC는 브라우저에서 디코딩할 수 없어 거부한다. */
export const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"];

/** 긴 변이 maxEdge 를 넘으면 비율을 유지해 줄인다(확대하지 않는다). */
export function fitSize(width: number, height: number, maxEdge: number = MAX_EDGE) {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

export class ImageError extends Error {}

/**
 * 사진을 리사이즈하고 JPEG로 다시 인코딩한다.
 * 캔버스를 거치므로 EXIF(GPS 포함)가 제거된다(서버도 한 번 더 제거).
 */
export async function compressImage(file: File): Promise<Blob> {
  if (!ACCEPTED_TYPES.includes(file.type)) {
    throw new ImageError("JPEG, PNG, WebP 사진만 올릴 수 있어요. (HEIC는 JPEG로 변환해 주세요)");
  }
  let bitmap: ImageBitmap;
  try {
    // 회전 정보(EXIF orientation)를 적용한 채로 디코딩해 방향이 틀어지지 않게 한다.
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new ImageError("사진을 읽을 수 없어요. 다른 사진을 선택해 주세요.");
  }
  const { width, height } = fitSize(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new ImageError("이 브라우저에서는 사진을 처리할 수 없어요.");
  // PNG의 투명 영역이 검게 보이지 않도록 흰 배경을 깐다.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY),
  );
  if (!blob) throw new ImageError("사진을 압축하지 못했어요.");
  return blob;
}
