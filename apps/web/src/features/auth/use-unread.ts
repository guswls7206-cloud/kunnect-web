"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/endpoints";
import type { UnreadCount } from "@/lib/api/types";
import { BADGE_POLL_MS, useMe } from "./use-me";

export const unreadKey = ["unread-count"] as const;

/**
 * 읽지 않음 배지. 계약상 폴링은 GET /notifications/unread-count 만 쓰고,
 * /me 의 unread 는 시작 시점 스냅샷이라 첫 렌더 값으로만 쓴다.
 */
export function useUnreadCounts(): UnreadCount {
  const { data: me } = useMe();
  const { data } = useQuery({
    queryKey: unreadKey,
    queryFn: api.notifications.unreadCount,
    enabled: Boolean(me),
    refetchInterval: BADGE_POLL_MS,
    // 폴링 오류는 배지만 못 갱신할 뿐이므로 화면 전체 오류로 번지지 않게 한다.
    retry: false,
  });
  return data ?? me?.unread ?? { notifications: 0, messages: 0 };
}
