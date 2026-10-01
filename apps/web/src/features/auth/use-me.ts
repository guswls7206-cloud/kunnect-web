"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/endpoints";
import { isApiError } from "@/lib/api/client";
import type { Me } from "@/lib/api/types";

export const meKey = ["me"] as const;

/** 알림·쪽지 읽지 않음 배지 갱신 주기(ms). 탭이 가려지면 TanStack Query가 자동으로 멈춘다. */
export const BADGE_POLL_MS = 15_000;

/** 현재 사용자. 미로그인(401)이면 null. 폴링하지 않는다(배지 폴링은 use-unread.ts). */
export function useMe() {
  return useQuery<Me | null>({
    queryKey: meKey,
    queryFn: async () => {
      try {
        return await api.me.get();
      } catch (error) {
        if (isApiError(error, 401)) return null;
        throw error;
      }
    },
  });
}
