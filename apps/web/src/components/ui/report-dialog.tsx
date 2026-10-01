"use client";

import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { isApiError } from "@/lib/api/client";
import { api } from "@/lib/api/endpoints";
import type { ReportReason, ReportTargetType } from "@/lib/api/types";
import { Button } from "./button";
import { inputClass } from "./field";
import { useToast } from "./toast";

const REASONS: Array<{ value: ReportReason; label: string }> = [
  { value: "SPAM", label: "스팸·광고" },
  { value: "HARASSMENT", label: "괴롭힘·욕설" },
  { value: "PRIVACY", label: "개인정보 노출" },
  { value: "FAKE", label: "허위·사기 의심" },
  { value: "OTHER", label: "기타" },
];

interface ReportDialogProps {
  open: boolean;
  onClose: () => void;
  targetType: ReportTargetType;
  targetId: number;
}

/** 신고 대화상자. 네이티브 <dialog>(showModal)라 포커스 가두기·ESC 닫기를 브라우저가 처리한다. */
export function ReportDialog({ open, onClose, targetType, targetId }: ReportDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const toast = useToast();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [detail, setDetail] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const report = useMutation({
    mutationFn: () =>
      api.reports.create({
        targetType,
        targetId,
        reason: reason!,
        detail: detail.trim() || undefined,
      }),
    onSuccess: () => {
      toast.show("신고가 접수되었어요.");
      setReason(null);
      setDetail("");
      onClose();
    },
    onError: (e) =>
      setError(isApiError(e) ? e.message : "신고하지 못했습니다. 잠시 후 다시 시도해 주세요."),
  });

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby="report-title"
      className="m-auto w-[calc(100%-2rem)] max-w-sm rounded-2xl border border-zinc-200/70 bg-white p-6 text-zinc-900 shadow-xl shadow-zinc-900/10 backdrop:bg-zinc-900/40 backdrop:backdrop-blur-sm"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          if (!reason) return setError("신고 사유를 선택해 주세요.");
          report.mutate();
        }}
        className="flex flex-col gap-3"
      >
        <h2 id="report-title" className="text-lg font-bold">
          신고하기
        </h2>
        <fieldset className="flex flex-col gap-1">
          <legend className="sr-only">신고 사유</legend>
          {REASONS.map((r) => (
            <label key={r.value} className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="radio"
                name="reason"
                value={r.value}
                checked={reason === r.value}
                onChange={() => setReason(r.value)}
              />
              {r.label}
            </label>
          ))}
        </fieldset>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-zinc-700">자세한 내용 (선택)</span>
          <textarea
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            maxLength={200}
            rows={3}
            className={`${inputClass} py-2`}
          />
        </label>
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={onClose}>
            취소
          </Button>
          <Button type="submit" variant="danger" loading={report.isPending}>
            신고
          </Button>
        </div>
      </form>
    </dialog>
  );
}
