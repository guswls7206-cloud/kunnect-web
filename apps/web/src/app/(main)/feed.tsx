"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { PinIcon, SearchIcon } from "@/components/icons";
import { PostCard } from "@/components/post/post-card";
import { Button, linkButtonClass } from "@/components/ui/button";
import { inputIconClass } from "@/components/ui/field";
import { EmptyState, ErrorState, PostCardSkeleton } from "@/components/ui/states";
import { useLocations } from "@/features/meta/queries";
import { usePostFeed } from "@/features/posts/queries";
import type { PostType } from "@/lib/api/types";

const TABS: Array<{ type: PostType; label: string }> = [
  { type: "LOST", label: "분실" },
  { type: "FOUND", label: "습득" },
];

const fieldIconClass =
  "pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-zinc-500";

/** 입력이 멈춘 뒤에만 검색어를 반영해 요청 수를 줄인다. */
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

export function Feed() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const type: PostType = params.get("type") === "FOUND" ? "FOUND" : "LOST";
  const buildingParam = params.get("buildingId") || undefined;

  const [search, setSearch] = useState(params.get("q") ?? "");
  const q = useDebounced(search.trim(), 300);
  const { data: locations } = useLocations();

  // 같은 건물의 여러 층은 buildingId 로 한 항목에 묶는다.
  const buildings = useMemo(() => {
    const seen = new Map<string, string>();
    locations?.forEach((l) => {
      if (!seen.has(l.buildingId)) seen.set(l.buildingId, l.buildingName);
    });
    return [...seen.entries()];
  }, [locations]);

  const query = useMemo(
    () => ({ type, q: q || undefined, buildingId: buildingParam }),
    [type, q, buildingParam],
  );
  const feed = usePostFeed(query);
  const items = feed.data?.pages.flatMap((page) => page.items) ?? [];

  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    router.replace(`${pathname}?${next.toString()}`);
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="sr-only">분실물 목록</h1>
      <div role="tablist" aria-label="글 유형" className="card grid grid-cols-2 gap-1 p-1.5">
        {TABS.map((tab) => (
          <button
            key={tab.type}
            role="tab"
            aria-selected={type === tab.type}
            onClick={() => setParam("type", tab.type === "LOST" ? null : tab.type)}
            className={`min-h-11 rounded-xl text-sm font-semibold transition-[background-color,color] ${
              type === tab.type
                ? "bg-brand-600 text-white shadow-sm"
                : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <SearchIcon className={fieldIconClass} />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="검색어를 입력하세요"
            aria-label="검색"
            className={inputIconClass}
          />
        </div>
        <div className="relative sm:w-44">
          <PinIcon className={fieldIconClass} />
          <select
            aria-label="위치 필터"
            value={buildingParam ?? ""}
            onChange={(e) => setParam("buildingId", e.target.value || null)}
            className={inputIconClass}
          >
            <option value="">전체 위치</option>
            {buildings.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <section
        aria-label={`${type === "LOST" ? "분실" : "습득"} 글 목록`}
        aria-busy={feed.isPending}
      >
        {feed.isPending ? (
          <ul className="flex flex-col gap-3">
            {[0, 1, 2, 3].map((i) => (
              <li key={i}>
                <PostCardSkeleton />
              </li>
            ))}
          </ul>
        ) : feed.isError ? (
          <div className="card">
            <ErrorState
              variant="section"
              message="글 목록을 불러오지 못했습니다."
              onRetry={() => feed.refetch()}
            />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            title={q || buildingParam ? "조건에 맞는 글이 없어요" : "아직 글이 없어요"}
            description="첫 글을 남겨 보세요."
            action={
              <Link href={`/posts/new?type=${type}`} className={linkButtonClass}>
                글쓰기
              </Link>
            }
          />
        ) : (
          <>
            <ul className="flex flex-col gap-3">
              {items.map((post) => (
                <PostCard key={post.id} post={post} />
              ))}
            </ul>
            {feed.hasNextPage && (
              <Button
                variant="secondary"
                className="mt-4 w-full"
                loading={feed.isFetchingNextPage}
                onClick={() => feed.fetchNextPage()}
              >
                더 보기
              </Button>
            )}
          </>
        )}
      </section>
    </div>
  );
}
