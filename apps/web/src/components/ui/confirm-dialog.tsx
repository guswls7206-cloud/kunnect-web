"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "./button";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** danger: 되돌릴 수 없는 작업(빨간 확인 버튼) */
  tone?: "danger" | "primary";
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 확인 대화상자. 네이티브 <dialog>(showModal)라 포커스 가두기·ESC 닫기를 브라우저가 처리한다.
 * 닫기(취소·ESC·바깥 클릭)는 모두 onCancel 로 알린다. 열릴 때는 실수로 확인하지 않도록 "취소"에 포커스를 둔다.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = "취소",
  tone = "danger",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      // showModal 을 지원하지 않는 환경(jsdom 등)에서는 open 속성만 켠다.
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    if (!open && dialog.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby="confirm-title"
      aria-describedby="confirm-desc"
      onCancel={(e) => {
        // ESC 로 닫힐 때 브라우저가 직접 닫지 않고 상태를 통해 닫도록 한다.
        e.preventDefault();
        onCancel();
      }}
      onClick={(e) => {
        // 바깥(backdrop) 클릭으로 닫기: 대화상자 자체가 클릭 대상일 때만(내용 클릭은 제외)
        if (e.target === ref.current) onCancel();
      }}
      className="card m-auto w-[calc(100%-2rem)] max-w-sm p-5 backdrop:bg-black/50"
    >
      <div className="flex flex-col gap-3">
        <h2 id="confirm-title" className="text-lg font-bold text-slate-900">
          {title}
        </h2>
        <p id="confirm-desc" className="text-sm leading-relaxed text-slate-700">
          {description}
        </p>
        <div className="mt-1 grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={onCancel} autoFocus>
            {cancelLabel}
          </Button>
          <Button variant={tone === "danger" ? "danger" : "primary"} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
