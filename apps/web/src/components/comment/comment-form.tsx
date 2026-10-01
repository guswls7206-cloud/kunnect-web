"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/field";
import { MAX_COMMENT_LENGTH } from "@/features/comments/queries";

interface CommentFormProps {
  /** 접근성 라벨(예: "댓글 입력", "답글 입력") */
  label: string;
  initialValue?: string;
  submitLabel: string;
  onSubmit: (body: string) => Promise<void>;
  onCancel?: () => void;
  autoFocus?: boolean;
  disabled?: boolean;
}

/** 댓글·답글·수정이 함께 쓰는 입력 폼. 제출 성공 시 입력을 비운다. */
export function CommentForm({
  label,
  initialValue = "",
  submitLabel,
  onSubmit,
  onCancel,
  autoFocus,
  disabled,
}: CommentFormProps) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const trimmed = value.trim();

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!trimmed || pending) return;
        setPending(true);
        setError(null);
        try {
          await onSubmit(trimmed);
          setValue("");
        } catch (err) {
          setError(err instanceof Error ? err.message : "등록하지 못했습니다.");
        } finally {
          setPending(false);
        }
      }}
      className="flex flex-col gap-2"
    >
      <label className="sr-only" htmlFor={`cf-${label}`}>
        {label}
      </label>
      <textarea
        id={`cf-${label}`}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        maxLength={MAX_COMMENT_LENGTH}
        rows={2}
        autoFocus={autoFocus}
        disabled={disabled}
        placeholder={disabled ? "종료된 글에는 댓글을 달 수 없어요" : label}
        className={`${inputClass} py-3 disabled:cursor-not-allowed disabled:bg-zinc-100`}
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-zinc-500" aria-live="off">
          {value.length}/{MAX_COMMENT_LENGTH}
        </span>
        <div className="flex gap-2">
          {onCancel && (
            <Button variant="ghost" onClick={onCancel}>
              취소
            </Button>
          )}
          <Button type="submit" loading={pending} disabled={disabled || !trimmed}>
            {submitLabel}
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      )}
    </form>
  );
}
