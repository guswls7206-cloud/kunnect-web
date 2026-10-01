"use client";

import { useEffect, useRef } from "react";
import { isApiError } from "@/lib/api/client";
import { api } from "@/lib/api/endpoints";
import { compressImage, ImageError, ACCEPTED_TYPES } from "@/lib/image";

export const MAX_PHOTOS = 3;

export interface PickedPhoto {
  /** 클라이언트 임시 id(서버 photoId 와 별개) */
  localId: string;
  previewUrl: string;
  status: "uploading" | "done" | "error";
  photoId?: number;
  error?: string;
}

interface PhotoPickerProps {
  photos: PickedPhoto[];
  onChange: (updater: (prev: PickedPhoto[]) => PickedPhoto[]) => void;
}

/** 사진 0~3장 선택. 고르는 즉시 압축 → 업로드(계약 5.4: 임시 사진 업로드 후 글 생성 시 photoIds 로 연결). */
export function PhotoPicker({ photos, onChange }: PhotoPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const photosRef = useRef(photos);
  useEffect(() => {
    photosRef.current = photos;
  }, [photos]);

  // 언마운트 시 미리보기 URL 정리
  useEffect(() => {
    return () => {
      photosRef.current.forEach(
        (p) => p.previewUrl.startsWith("blob:") && URL.revokeObjectURL(p.previewUrl),
      );
    };
  }, []);

  async function addFiles(files: FileList | null) {
    if (!files) return;
    const room = MAX_PHOTOS - photos.length;
    const selected = Array.from(files).slice(0, Math.max(0, room));
    for (const file of selected) {
      const localId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const previewUrl = URL.createObjectURL(file);
      onChange((prev) => [...prev, { localId, previewUrl, status: "uploading" }]);
      try {
        const compressed = await compressImage(file);
        const uploaded = await api.photos.upload(compressed, "photo.jpg");
        onChange((prev) =>
          prev.map((p) =>
            p.localId === localId ? { ...p, status: "done", photoId: uploaded.photoId } : p,
          ),
        );
      } catch (error) {
        const message =
          error instanceof ImageError || isApiError(error)
            ? error.message
            : "사진을 올리지 못했어요. 다시 시도해 주세요.";
        onChange((prev) =>
          prev.map((p) => (p.localId === localId ? { ...p, status: "error", error: message } : p)),
        );
      }
    }
    if (inputRef.current) inputRef.current.value = "";
  }

  function remove(photo: PickedPhoto) {
    onChange((prev) => prev.filter((p) => p.localId !== photo.localId));
    if (photo.previewUrl.startsWith("blob:")) URL.revokeObjectURL(photo.previewUrl);
    // 서버의 임시 사진도 지운다. 실패해도 24시간 뒤 서버가 정리하므로 무시한다.
    if (photo.photoId) api.photos.remove(photo.photoId).catch(() => undefined);
  }

  const full = photos.length >= MAX_PHOTOS;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-zinc-800">
          사진 <span className="font-normal text-zinc-500">(선택, 최대 {MAX_PHOTOS}장)</span>
        </span>
        <span className="text-xs text-zinc-500" aria-live="polite">
          {photos.length}/{MAX_PHOTOS}
        </span>
      </div>

      <ul className="grid grid-cols-3 gap-2">
        {photos.map((photo, i) => (
          <li
            key={photo.localId}
            className="relative aspect-square overflow-hidden rounded-xl bg-zinc-100 ring-1 ring-zinc-200 ring-inset"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photo.previewUrl}
              alt={`선택한 사진 ${i + 1}`}
              className="h-full w-full object-cover"
            />
            {photo.status === "uploading" && (
              <div
                role="status"
                className="absolute inset-0 flex items-center justify-center bg-black/40 text-xs text-white"
              >
                올리는 중…
              </div>
            )}
            {photo.status === "error" && (
              <div
                role="alert"
                className="absolute inset-0 flex items-center justify-center bg-red-900/70 p-1 text-center text-[11px] leading-tight text-white"
              >
                {photo.error}
              </div>
            )}
            <button
              type="button"
              onClick={() => remove(photo)}
              aria-label={`사진 ${i + 1} 삭제`}
              className="absolute right-1 top-1 flex h-8 w-8 items-center justify-center rounded-full bg-black/60 text-base text-white"
            >
              ×
            </button>
          </li>
        ))}
        {!full && (
          <li>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="flex aspect-square w-full flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-brand-200 bg-brand-50/60 text-sm font-medium text-brand-700 transition-[background-color,border-color] hover:border-brand-400 hover:bg-brand-50"
            >
              <span className="text-2xl leading-none" aria-hidden="true">
                +
              </span>
              사진 추가
            </button>
          </li>
        )}
      </ul>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_TYPES.join(",")}
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-label="사진 파일 선택"
        onChange={(e) => addFiles(e.target.files)}
      />

      <p className="text-xs text-zinc-500">
        얼굴·학생증 번호 등 개인정보가 보이지 않게 해 주세요. 위치 정보(EXIF)는 올리기 전에
        제거돼요. 사진은 비슷한 글을 찾기 위해 AI(Claude API)로 전송돼요.
      </p>
    </div>
  );
}
