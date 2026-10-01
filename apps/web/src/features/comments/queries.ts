"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/endpoints";

export const commentKeys = {
  list: (postId: number) => ["comments", postId] as const,
};

export function useComments(postId: number) {
  return useInfiniteQuery({
    queryKey: commentKeys.list(postId),
    queryFn: ({ pageParam }) => api.comments.list(postId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
}

export const MAX_COMMENT_LENGTH = 300;
export const MASKED_NOTICE = "연락처로 보이는 내용은 가려졌어요. 개인 연락은 쪽지로 해 주세요.";
