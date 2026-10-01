"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { isApiError } from "@/lib/api/client";
import { api } from "@/lib/api/endpoints";

/** 설정 화면 맨 아래의 "탈퇴하기" 버튼과 비밀번호 확인 대화상자 */
export function WithdrawSection() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="dangerSecondary" onClick={() => setOpen(true)}>
        탈퇴하기
      </Button>
      <WithdrawDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/**
 * 탈퇴 확인 대화상자. 네이티브 <dialog>(showModal)라 포커스 가두기·ESC 닫기를 브라우저가 처리한다.
 * 안내 내용은 백엔드 DELETE /me 동작(글·댓글 즉시 영구 삭제, 아이디·닉네임 익명화, 쪽지는 상대에게 읽기 전용으로 유지)과 맞춘다.
 */
function WithdrawDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const router = useRouter();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    // showModal 이 없는 환경(테스트용 jsdom)에서는 open 속성으로 대신한다.
    if (open && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    if (!open && dialog.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
  }, [open]);

  function close() {
    setPassword("");
    setError(null);
    onClose();
  }

  const withdraw = useMutation({
    mutationFn: () => api.me.withdraw(password),
    onSuccess: () => {
      queryClient.clear();
      toast.show("탈퇴가 완료되었어요.");
      router.replace("/login");
    },
    onError: (e) => {
      if (isApiError(e, 403)) return setError(e.message);
      toast.show(
        isApiError(e) ? e.message : "탈퇴하지 못했습니다. 잠시 후 다시 시도해 주세요.",
        "error",
      );
    },
  });

  return (
    <dialog
      ref={ref}
      onClose={close}
      aria-labelledby={titleId}
      className="m-auto w-[calc(100%-2rem)] max-w-sm rounded-2xl border border-zinc-200/70 bg-white p-6 text-zinc-900 shadow-xl shadow-zinc-900/10 backdrop:bg-zinc-900/40 backdrop:backdrop-blur-sm"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          if (!password) return setError("비밀번호를 입력해 주세요.");
          withdraw.mutate();
        }}
        className="flex flex-col gap-4"
        noValidate
      >
        <h2 id={titleId} className="text-lg font-bold">
          탈퇴하기
        </h2>
        <ul className="list-disc space-y-1 rounded-lg bg-red-50 py-3 pr-3 pl-7 text-sm leading-relaxed text-red-800">
          <li>탈퇴하면 계정을 되살릴 수 없어요.</li>
          <li>작성한 글과 댓글은 바로 영구 삭제돼요.</li>
          <li>아이디·닉네임은 지워지고 &quot;탈퇴한사용자&quot;로 표시돼요.</li>
          <li>진행 중인 인수 요청은 취소되고, 쪽지 대화는 상대방에게 읽기 전용으로 남아요.</li>
        </ul>
        <Field label="비밀번호 확인" error={error ?? undefined} required>
          {(p) => (
            <input
              {...p}
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError(null);
              }}
              autoComplete="current-password"
              className={inputClass}
            />
          )}
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={close}>
            취소
          </Button>
          <Button type="submit" variant="danger" loading={withdraw.isPending}>
            탈퇴하기
          </Button>
        </div>
      </form>
    </dialog>
  );
}
