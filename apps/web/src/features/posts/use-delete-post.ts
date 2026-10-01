"use client";

import { useQueryClient, type InfiniteData, type Query } from "@tanstack/react-query";
import { useCallback } from "react";
import { useToast } from "@/components/ui/toast";
import { unreadKey } from "@/features/auth/use-unread";
import { isApiError } from "@/lib/api/client";
import { api } from "@/lib/api/endpoints";
import type { Page, PostCardData } from "@/lib/api/types";
import { postKeys } from "./queries";

type PostListData = InfiniteData<Page<PostCardData>, string | null>;

/** 글 목록 계열(피드·내 글) 캐시만 고른다. 상세 캐시는 모양이 달라 제외한다. */
const isPostList = (query: Query) => {
  const data = query.state.data as { pages?: unknown } | undefined;
  return Array.isArray(data?.pages);
};

interface DeleteOptions {
  /** 서버에서 삭제가 끝난 직후(캐시 정리 전)에 호출한다. 상세 화면에서 목록으로 이동할 때 쓴다. */
  onDeleted?: () => void;
}

/**
 * 내가 쓴 글을 영구 삭제한다(DELETE /posts/{id}, 복구 불가). '종료'(status CLOSED)와는 다른 동작이다.
 * - 낙관적 제거: 요청 전에 피드·내 글 목록에서 빼고, 실패하면 되돌린다.
 * - 404 는 이미 삭제된 것이므로 목록에서 뺀 채로 두고 오류로 보이지 않게 안내한다(재삭제는 404).
 * - 409(인수 진행 중 등)·403·네트워크 오류는 되돌리고 오류 안내를 보여준다.
 * - 끝나면 글·매칭·알림·읽지 않음 배지 캐시를 정리한다.
 * 반환 함수는 삭제됨(또는 이미 없음)이면 true, 되돌렸으면 false.
 */
export function useDeletePost() {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useCallback(
    async (id: number, options: DeleteOptions = {}): Promise<boolean> => {
      await queryClient.cancelQueries({ queryKey: postKeys.all, predicate: isPostList });
      const snapshots = queryClient.getQueriesData<PostListData>({
        queryKey: postKeys.all,
        predicate: isPostList,
      });
      queryClient.setQueriesData<PostListData>(
        { queryKey: postKeys.all, predicate: isPostList },
        (data) =>
          data
            ? {
                ...data,
                pages: data.pages.map((p) => ({ ...p, items: p.items.filter((c) => c.id !== id) })),
              }
            : data,
      );

      const finish = () => {
        options.onDeleted?.();
        // 이동한 뒤에 상세·댓글·매칭 캐시를 지운다(지우는 순간 상세 화면이 "없음"으로 깜빡이지 않게).
        setTimeout(() => {
          queryClient.removeQueries({ queryKey: postKeys.detail(id) });
          queryClient.removeQueries({ queryKey: ["comments", id] });
          queryClient.removeQueries({ queryKey: ["matches", id] });
        }, 0);
        queryClient.invalidateQueries({
          queryKey: postKeys.all,
          predicate: (q) => !(q.queryKey[1] === "detail" && q.queryKey[2] === id),
        });
        queryClient.invalidateQueries({ queryKey: ["matches"] });
        queryClient.invalidateQueries({ queryKey: ["notifications"] });
        queryClient.invalidateQueries({ queryKey: unreadKey });
      };

      try {
        await api.posts.remove(id);
        toast.show("글을 삭제했어요.");
        finish();
        return true;
      } catch (error) {
        if (isApiError(error, 404)) {
          toast.show("이미 삭제된 글이에요.");
          finish();
          return true;
        }
        for (const [key, data] of snapshots) queryClient.setQueryData(key, data);
        let message = "글을 삭제하지 못했습니다. 잠시 후 다시 시도해 주세요.";
        if (isApiError(error, 409)) {
          message =
            error.code === "ACTIVE_HANDOVER"
              ? "진행 중인 인수 요청이 있어 삭제할 수 없습니다. 먼저 인수를 완료하거나 거절해 주세요."
              : error.message;
        } else if (isApiError(error, 403)) message = "내가 쓴 글만 삭제할 수 있어요.";
        else if (isApiError(error, 429)) message = "잠시 후 다시 시도해 주세요.";
        toast.show(message, "error");
        queryClient.invalidateQueries({ queryKey: postKeys.all });
        return false;
      }
    },
    [queryClient, toast],
  );
}
