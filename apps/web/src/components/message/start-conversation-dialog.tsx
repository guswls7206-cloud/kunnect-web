"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/field";
import { messageKeys, MAX_MESSAGE_LENGTH } from "@/features/messages/queries";
import { isApiError } from "@/lib/api/client";
import { api } from "@/lib/api/endpoints";

interface Props {
  open: boolean;
  onClose: () => void;
  /** 상대 닉네임(안내 문구용) */
  nickname: string;
  targetUserId?: number;
  postId?: number;
}

/** 글 또는 프로필에서 쪽지를 시작하는 대화상자. 기존 대화가 있으면 서버가 재사용한다. */
export function StartConversationDialog({ open, onClose, nickname, targetUserId, postId }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const queryClient = useQueryClient();
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const start = useMutation({
    mutationFn: () => api.conversations.start({ targetUserId, postId, body: body.trim() }),
    onSuccess: ({ conversation }) => {
      queryClient.invalidateQueries({ queryKey: messageKeys.inbox });
      setBody("");
      onClose();
      router.push(`/messages/${conversation.id}`);
    },
    onError: (e) => {
      if (!isApiError(e)) return setError("보내지 못했습니다. 잠시 후 다시 시도해 주세요.");
      // 차단 여부는 드러내지 않는 중립 문구를 그대로 보여준다.
      setError(
        e.code === "RATE_LIMITED" ? "오늘 새로 시작할 수 있는 쪽지 수를 넘었어요." : e.message,
      );
    },
  });

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby="start-title"
      className="m-auto w-[calc(100%-2rem)] max-w-sm rounded-2xl border border-slate-200/70 bg-white p-6 text-slate-900 shadow-xl shadow-slate-900/10 backdrop:bg-slate-900/40 backdrop:backdrop-blur-sm"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          if (!body.trim()) return setError("내용을 입력해 주세요.");
          start.mutate();
        }}
        className="flex flex-col gap-3"
      >
        <h2 id="start-title" className="text-lg font-bold text-slate-900">
          {nickname}님에게 쪽지 보내기
        </h2>
        <label className="flex flex-col gap-1 text-sm">
          <span className="sr-only">쪽지 내용</span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={MAX_MESSAGE_LENGTH}
            rows={4}
            placeholder="내용을 입력해 주세요"
            className={`${inputClass} resize-none py-3`}
          />
          <span className="text-right text-xs text-slate-500">
            {body.length}/{MAX_MESSAGE_LENGTH}
          </span>
        </label>
        <p className="rounded-lg bg-slate-100/80 px-3 py-2 text-xs leading-relaxed text-slate-600">
          전달 방법(직접 만남 또는 보관함·택배 등 비대면)은 앱 안에서 협의해 주세요. 직접 만난다면
          사람이 많은 공공장소를 이용해 주세요.
        </p>
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={onClose}>
            취소
          </Button>
          <Button type="submit" loading={start.isPending}>
            보내기
          </Button>
        </div>
      </form>
    </dialog>
  );
}
