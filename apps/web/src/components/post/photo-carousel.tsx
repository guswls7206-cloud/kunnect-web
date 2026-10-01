"use client";

import { useRef, useState } from "react";
import type { PostPhoto } from "@/lib/api/types";

/** 가로 스크롤 스냅 캐러셀. 사진이 없으면 아무것도 그리지 않는다. */
export function PhotoCarousel({ photos, title }: { photos: PostPhoto[]; title: string }) {
  const ref = useRef<HTMLUListElement>(null);
  const [index, setIndex] = useState(0);
  if (photos.length === 0) return null;

  function onScroll() {
    const el = ref.current;
    if (!el) return;
    setIndex(Math.round(el.scrollLeft / el.clientWidth));
  }

  return (
    <div className="relative overflow-hidden rounded-xl bg-zinc-100">
      <ul
        ref={ref}
        onScroll={onScroll}
        tabIndex={0}
        aria-label={`${title} 사진`}
        className="flex snap-x snap-mandatory overflow-x-auto"
      >
        {photos.map((photo, i) => (
          <li key={photo.photoId} className="w-full shrink-0 snap-center">
            {/* 사용자 업로드 이미지라 next/image 최적화를 쓰지 않는다. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photo.url}
              alt={`${title} 사진 ${i + 1}/${photos.length}`}
              width={photo.width}
              height={photo.height}
              className="aspect-[4/3] w-full object-cover"
            />
          </li>
        ))}
      </ul>
      {photos.length > 1 && (
        <span
          aria-hidden="true"
          className="absolute bottom-2 right-2 rounded-full bg-black/60 px-2 py-0.5 text-xs text-white"
        >
          {index + 1}/{photos.length}
        </span>
      )}
    </div>
  );
}
