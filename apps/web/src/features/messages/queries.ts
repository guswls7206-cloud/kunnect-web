"use client";

import { useInfiniteQuery, useQuery, type QueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/endpoints";
import type { Message } from "@/lib/api/types";

/** 폴링 주기(ms): 대화 화면 5초, 쪽지함 10초(앱이 열려 있고 탭이 보일 때만 동작). */
export const CHAT_POLL_MS = 5_000;
export const INBOX_POLL_MS = 10_000;
export const PAGE_SIZE = 30;
export const MAX_MESSAGE_LENGTH = 1000;

export const messageKeys = {
  inbox: ["conversations"] as const,
  conversation: (id: number) => ["conversation", id] as const,
  messages: (id: number) => ["messages", id] as const,
  /** 서버에서 마지막으로 받은 메시지 id(폴링 커서). 내가 보낸 메시지로는 앞당기지 않는다. */
  cursor: (id: number) => ["messages-cursor", id] as const,
};

export function useInbox() {
  return useInfiniteQuery({
    queryKey: messageKeys.inbox,
    queryFn: ({ pageParam }) => api.conversations.list(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: INBOX_POLL_MS,
  });
}

export function useConversation(id: number) {
  return useQuery({
    queryKey: messageKeys.conversation(id),
    queryFn: () => api.conversations.get(id),
    enabled: id > 0,
    refetchInterval: INBOX_POLL_MS,
  });
}

/** id 기준 중복을 제거하고 오름차순으로 합친다(폴링과 직접 전송이 겹쳐도 한 번만 보이게). */
export function mergeMessages(prev: Message[], incoming: Message[]): Message[] {
  if (incoming.length === 0) return prev;
  const map = new Map(prev.map((m) => [m.id, m]));
  for (const m of incoming) map.set(m.id, m);
  const merged = [...map.values()].sort((a, b) => a.id - b.id);
  return merged.length === prev.length ? prev : merged;
}

/**
 * 대화 메시지. 첫 조회는 최근 PAGE_SIZE개, 이후 폴링은 마지막 id 이후(afterId)만 가져와 이어 붙인다.
 * 변경이 없으면 이전 배열을 그대로 돌려줘 불필요한 렌더를 막는다.
 */
export function useMessages(id: number) {
  return useQuery({
    queryKey: messageKeys.messages(id),
    queryFn: async ({ client }) => {
      const prev = client.getQueryData<Message[]>(messageKeys.messages(id)) ?? [];
      // 폴링 커서는 서버에서 받은 마지막 id 만 따른다. 내가 방금 보낸 메시지(id 가 더 클 수 있음)를 기준으로 삼으면
      // 그 사이 도착한 상대 메시지를 건너뛰게 된다.
      // 캐시가 비어 있으면(다른 화면에서 정리됨) 커서도 무시하고 처음부터 다시 받는다.
      const cursor =
        prev.length > 0 ? client.getQueryData<number>(messageKeys.cursor(id)) : undefined;
      const { items } = await api.conversations.messages(
        id,
        cursor ? { afterId: cursor } : { limit: PAGE_SIZE },
      );
      if (items.length > 0)
        client.setQueryData(
          messageKeys.cursor(id),
          Math.max(cursor ?? 0, items[items.length - 1].id),
        );
      return mergeMessages(prev, items);
    },
    enabled: id > 0,
    refetchInterval: CHAT_POLL_MS,
    staleTime: 0,
  });
}

/** 전송 직후 응답 메시지를 캐시에 바로 반영한다. */
export function appendMessage(client: QueryClient, id: number, message: Message) {
  client.setQueryData<Message[]>(messageKeys.messages(id), (prev) =>
    mergeMessages(prev ?? [], [message]),
  );
}
