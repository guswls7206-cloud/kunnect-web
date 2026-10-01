"use client";

import { useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useCallback } from "react";
import { useToast } from "@/components/ui/toast";
import { unreadKey } from "@/features/auth/use-unread";
import { isApiError } from "@/lib/api/client";
import { api } from "@/lib/api/endpoints";
import type { ConversationItem, Page } from "@/lib/api/types";
import { messageKeys } from "./queries";

type InboxData = InfiniteData<Page<ConversationItem>, string | null>;

/**
 * 쪽지함에서 대화 삭제(내 쪽지함에서만, 상대에게는 영향 없음).
 * - 낙관적 제거: 요청 전에 목록에서 빼고, 실패하면(409·네트워크 등) 되돌린다.
 * - 404 는 이미 삭제된 것이므로 목록에서 뺀 채로 둔다. 204 도 서버가 멱등으로 응답한다.
 * - 끝나면 쪽지함·읽지 않음 배지를 다시 불러온다.
 * 반환 함수는 성공(삭제됨) 시 true, 되돌렸으면 false.
 */
export function useDeleteConversation() {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useCallback(
    async (id: number): Promise<boolean> => {
      await queryClient.cancelQueries({ queryKey: messageKeys.inbox });
      const previous = queryClient.getQueryData<InboxData>(messageKeys.inbox);
      queryClient.setQueryData<InboxData>(messageKeys.inbox, (data) =>
        data
          ? {
              ...data,
              pages: data.pages.map((p) => ({ ...p, items: p.items.filter((c) => c.id !== id) })),
            }
          : data,
      );

      const refresh = () => {
        queryClient.invalidateQueries({ queryKey: messageKeys.inbox });
        queryClient.invalidateQueries({ queryKey: unreadKey });
      };

      try {
        await api.conversations.remove(id);
        // 삭제한 대화의 캐시(대화방 화면·메시지·폴링 커서)를 비운다.
        queryClient.removeQueries({ queryKey: messageKeys.conversation(id) });
        queryClient.removeQueries({ queryKey: messageKeys.messages(id) });
        queryClient.removeQueries({ queryKey: messageKeys.cursor(id) });
        toast.show("대화를 삭제했어요.");
        refresh();
        return true;
      } catch (error) {
        if (isApiError(error, 404)) {
          toast.show("이미 삭제된 대화예요.");
          refresh();
          return true;
        }
        queryClient.setQueryData(messageKeys.inbox, previous);
        toast.show(
          isApiError(error, 409)
            ? "진행 중인 인수 요청이 있어 삭제할 수 없습니다."
            : isApiError(error, 429)
              ? "잠시 후 다시 시도해 주세요."
              : "대화를 삭제하지 못했습니다. 잠시 후 다시 시도해 주세요.",
          "error",
        );
        refresh();
        return false;
      }
    },
    [queryClient, toast],
  );
}
