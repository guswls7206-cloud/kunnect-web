"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/endpoints";
import type { PostListQuery } from "@/lib/api/types";

export const postKeys = {
  all: ["posts"] as const,
  feed: (query: PostListQuery) => ["posts", "feed", query] as const,
  mine: (query: { type?: string; status?: string }) => ["posts", "mine", query] as const,
  detail: (id: number) => ["posts", "detail", id] as const,
};

export function usePostFeed(query: PostListQuery) {
  return useInfiniteQuery({
    queryKey: postKeys.feed(query),
    queryFn: ({ pageParam }) => api.posts.list({ ...query, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function useMyPosts(query: { type?: string; status?: string } = {}) {
  return useInfiniteQuery({
    queryKey: postKeys.mine(query),
    queryFn: ({ pageParam }) => api.me.posts({ ...query, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function usePostDetail(id: number) {
  return useQuery({
    queryKey: postKeys.detail(id),
    queryFn: () => api.posts.get(id),
    enabled: Number.isInteger(id) && id > 0,
    // 글 작성 직후 매칭이 비동기로 진행 중이면 상태가 바뀔 때까지 폴링한다.
    refetchInterval: (query) => (query.state.data?.matchState === "PENDING" ? 4_000 : false),
  });
}
