"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { messageKeys } from "@/features/messages/queries";
import { postKeys, usePostDetail } from "@/features/posts/queries";
import { isApiError } from "@/lib/api/client";
import { api } from "@/lib/api/endpoints";
import type { ConversationItem } from "@/lib/api/types";

/**
 * 인수(반환) 진행 패널. README 15절 흐름:
 * 인수 시작 → (습득자) 소유 확인 질문 → (분실자) 답변 → 습득자 소유 확인 → 양측 인수 완료 확인 → 글 RETURNED.
 * 분실자/습득자 역할은 관련 글(postContext)의 유형과 작성자 여부로 판단한다.
 */
export function HandoverPanel({ conversation }: { conversation: ConversationItem }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const context = conversation.postContext;
  const { data: post } = usePostDetail(context?.id ?? 0);
  // 이 기기에서 이미 "인수 완료"를 눌렀는지(계약에 내 완료 여부 필드가 없어 로컬로만 추적).
  const [completedLocally, setCompletedLocally] = useState<number | null>(null);

  const handover = conversation.handover ?? null;

  function refresh() {
    queryClient.invalidateQueries({ queryKey: messageKeys.conversation(conversation.id) });
    queryClient.invalidateQueries({ queryKey: messageKeys.messages(conversation.id) });
    queryClient.invalidateQueries({ queryKey: postKeys.all });
  }

  const onError = (e: unknown) =>
    toast.show(isApiError(e) ? e.message : "처리하지 못했습니다.", "error");

  const request = useMutation({
    mutationFn: () => api.handovers.request(conversation.id, { postId: context!.id }),
    onSuccess: refresh,
    onError,
  });
  const verify = useMutation({
    mutationFn: () => api.handovers.verify(handover!.id),
    onSuccess: refresh,
    onError,
  });
  const reject = useMutation({
    mutationFn: () => api.handovers.reject(handover!.id),
    onSuccess: refresh,
    onError,
  });
  const complete = useMutation({
    mutationFn: () => api.handovers.complete(handover!.id),
    onSuccess: (h) => {
      setCompletedLocally(h.id);
      toast.show(
        h.status === "COMPLETED"
          ? "인수가 완료되었어요."
          : "내 확인을 기록했어요. 상대방의 확인을 기다려요.",
      );
      refresh();
    },
    onError,
  });

  if (!context) return null;
  const iAmFinder = post ? (post.type === "FOUND" ? post.isMine : !post.isMine) : null;

  // 모든 인수 상태 공통: 앱의 흰 카드(card: 흰 배경·rounded-2xl·옅은 테두리·그림자)
  const box = "card flex flex-col gap-2 p-4 text-sm leading-relaxed text-slate-700";

  if (handover?.status === "COMPLETED") {
    return (
      <section aria-label="인수 상태" className={box}>
        <strong className="text-brand-700">인수가 완료되었어요 🎉</strong>
        <span>물건이 주인에게 돌아갔어요. 이 대화는 일정 기간 뒤 자동으로 삭제돼요.</span>
      </section>
    );
  }

  if (!handover || handover.status === "REJECTED") {
    if (conversation.readOnly) return null;
    return (
      <section aria-label="인수 상태" className={box}>
        {handover?.status === "REJECTED" && (
          <span className="text-slate-600">이전 인수 요청이 거절되었어요.</span>
        )}
        <span>
          소유 확인이 끝나고 전달 방법(직접 만남 또는 비대면)을 정했다면 인수 절차를 시작해 주세요.
        </span>
        <Button loading={request.isPending} onClick={() => request.mutate()}>
          인수 절차 시작
        </Button>
      </section>
    );
  }

  return (
    <section aria-label="인수 상태" className={box}>
      {handover.status === "REQUESTED" && (
        <>
          <strong className="text-brand-700">소유 확인 중</strong>
          {iAmFinder === null ? null : iAmFinder ? (
            <>
              <span>
                &apos;소유 확인 질문&apos;으로 물건의 특징을 물어보고, 맞는 주인이라고 판단되면
                확인해 주세요.
              </span>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="secondary"
                  loading={reject.isPending}
                  onClick={() => reject.mutate()}
                >
                  거절
                </Button>
                <Button loading={verify.isPending} onClick={() => verify.mutate()}>
                  소유 확인 완료
                </Button>
              </div>
            </>
          ) : (
            <span>
              습득자가 소유 여부를 확인하고 있어요. 질문이 오면 &apos;소유 확인 답변&apos;으로 답해
              주세요.
            </span>
          )}
        </>
      )}
      {handover.status === "VERIFIED" && (
        <>
          <strong className="text-brand-700">소유 확인 완료</strong>
          <span>
            정한 방법으로 물건을 전달해 주세요. 직접 만난다면 사람이 많은 공공장소를 이용하고,
            비대면이라면 보관 장소·전달 방법을 쪽지로 꼭 확인해 주세요. 물건을 주고받았다면 아래
            버튼으로 확인해 주세요.
          </span>
          <Button
            loading={complete.isPending}
            disabled={completedLocally === handover.id}
            onClick={() => complete.mutate()}
          >
            {completedLocally === handover.id ? "상대방 확인 대기 중" : "인수 완료 확인"}
          </Button>
        </>
      )}
    </section>
  );
}
