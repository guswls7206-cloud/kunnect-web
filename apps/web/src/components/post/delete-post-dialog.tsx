"use client";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";

interface DeletePostDialogProps {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** 글 영구 삭제 확인(내 정보 목록과 글 상세가 같은 문구를 쓴다). */
export function DeletePostDialog({ open, onConfirm, onCancel }: DeletePostDialogProps) {
  return (
    <ConfirmDialog
      open={open}
      title="이 글을 삭제할까요?"
      description="삭제한 글과 댓글·매칭은 복구할 수 없습니다."
      confirmLabel="삭제"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
