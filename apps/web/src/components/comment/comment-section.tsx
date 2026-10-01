"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ReportDialog } from "@/components/ui/report-dialog";
import { ErrorState, Spinner } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { commentKeys, MASKED_NOTICE, useComments } from "@/features/comments/queries";
import { postKeys } from "@/features/posts/queries";
import { api } from "@/lib/api/endpoints";
import type { Comment } from "@/lib/api/types";
import { relativeTime } from "@/lib/format";
import { CommentForm } from "./comment-form";

interface CommentSectionProps {
  postId: number;
  /** RETURNED/CLOSED 글은 새 댓글을 달 수 없다 */
  closed: boolean;
  /** 글쓴이 id. 글쓴이가 쓴 댓글·답글은 이름 뒤에 "(글쓴이)"를 붙여 강조한다 */
  postAuthorId?: number;
}

export function CommentSection({ postId, closed, postAuthorId }: CommentSectionProps) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const comments = useComments(postId);
  const [replyingTo, setReplyingTo] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [reportTarget, setReportTarget] = useState<number | null>(null);
  const items = comments.data?.pages.flatMap((p) => p.items) ?? [];

  // 알림에서 #comment-ID 로 들어오면 해당 댓글로 스크롤한다.
  useEffect(() => {
    if (!comments.isSuccess) return;
    const hash = window.location.hash;
    if (hash.startsWith("#comment-"))
      document.getElementById(hash.slice(1))?.scrollIntoView({ block: "center" });
  }, [comments.isSuccess]);

  function refresh() {
    queryClient.invalidateQueries({ queryKey: commentKeys.list(postId) });
    queryClient.invalidateQueries({ queryKey: postKeys.detail(postId) });
  }

  async function submit(body: string, parentId?: number) {
    const { masked } = await api.comments.create(postId, { body, parentId });
    if (masked) toast.show(MASKED_NOTICE);
    setReplyingTo(null);
    refresh();
  }

  async function edit(id: number, body: string) {
    const { masked } = await api.comments.update(id, body);
    if (masked) toast.show(MASKED_NOTICE);
    setEditing(null);
    refresh();
  }

  async function remove(id: number) {
    if (!window.confirm("댓글을 삭제할까요?")) return;
    try {
      await api.comments.remove(id);
      refresh();
    } catch {
      toast.show("삭제하지 못했습니다.", "error");
    }
  }

  const count = items.reduce((n, c) => n + (c.status === "VISIBLE" ? 1 : 0) + c.replies.length, 0);

  function renderComment(c: Comment, isReply: boolean) {
    const deleted = c.status === "DELETED";
    const byPostAuthor = !deleted && postAuthorId !== undefined && c.author.id === postAuthorId;
    return (
      <li
        key={c.id}
        id={`comment-${c.id}`}
        className={`scroll-mt-20 py-3 ${isReply ? "ml-5 border-l-2 border-brand-100 pl-4" : ""}`}
      >
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          {/* "(글쓴이)"는 텍스트로 두어 스크린리더도 함께 읽는다. */}
          <span className={`font-semibold ${byPostAuthor ? "text-brand-700" : "text-zinc-800"}`}>
            {deleted ? "알 수 없음" : c.author.nickname}
            {byPostAuthor && "(글쓴이)"}
          </span>
          <span>{relativeTime(c.createdAt)}</span>
          {c.editedAt && !deleted && <span>(수정됨)</span>}
        </div>

        {deleted ? (
          <p className="mt-1 text-sm italic text-zinc-500">삭제된 댓글입니다.</p>
        ) : editing === c.id ? (
          <div className="mt-2">
            <CommentForm
              label="댓글 수정"
              initialValue={c.body ?? ""}
              submitLabel="저장"
              autoFocus
              onSubmit={(body) => edit(c.id, body)}
              onCancel={() => setEditing(null)}
            />
          </div>
        ) : (
          <p className="mt-1 whitespace-pre-wrap text-sm text-zinc-800">{c.body}</p>
        )}

        {!deleted && editing !== c.id && (
          <div className="mt-1 flex flex-wrap gap-1 text-xs">
            {!isReply && !closed && (
              <Button
                variant="ghost"
                className="min-h-9 px-2 text-xs"
                onClick={() => setReplyingTo(replyingTo === c.id ? null : c.id)}
              >
                답글
              </Button>
            )}
            {c.isMine ? (
              <>
                <Button
                  variant="ghost"
                  className="min-h-9 px-2 text-xs"
                  onClick={() => setEditing(c.id)}
                >
                  수정
                </Button>
                <Button
                  variant="ghost"
                  className="min-h-9 px-2 text-xs"
                  onClick={() => remove(c.id)}
                >
                  삭제
                </Button>
              </>
            ) : (
              <Button
                variant="ghost"
                className="min-h-9 px-2 text-xs"
                onClick={() => setReportTarget(c.id)}
              >
                신고
              </Button>
            )}
          </div>
        )}

        {replyingTo === c.id && (
          <div className="ml-5 mt-2">
            <CommentForm
              label="답글 입력"
              submitLabel="답글 등록"
              autoFocus
              onSubmit={(body) => submit(body, c.id)}
              onCancel={() => setReplyingTo(null)}
            />
          </div>
        )}

        {c.replies.length > 0 && <ul>{c.replies.map((r) => renderComment(r, true))}</ul>}
      </li>
    );
  }

  return (
    <section aria-labelledby="comments-heading" className="card p-4 sm:p-6">
      <h2 id="comments-heading" className="text-lg font-bold text-zinc-900">
        댓글 <span className="text-brand-600">{count}</span>
      </h2>
      <p className="mt-1 text-xs text-zinc-500">
        전화번호·이메일·SNS 아이디는 자동으로 가려져요. 개인 연락은 쪽지로 해 주세요.
      </p>

      <div className="mt-3">
        <CommentForm
          label="댓글 입력"
          submitLabel="등록"
          disabled={closed}
          onSubmit={(body) => submit(body)}
        />
      </div>

      {comments.isPending ? (
        <Spinner />
      ) : comments.isError ? (
        <ErrorState
          variant="section"
          message="댓글을 불러오지 못했습니다."
          onRetry={() => comments.refetch()}
        />
      ) : items.length === 0 ? (
        <p className="py-6 text-center text-sm text-zinc-500">첫 댓글을 남겨 보세요.</p>
      ) : (
        <ul className="mt-2 divide-y divide-zinc-100">
          {items.map((c) => renderComment(c, false))}
        </ul>
      )}

      {comments.hasNextPage && (
        <Button
          variant="secondary"
          className="mt-3 w-full"
          loading={comments.isFetchingNextPage}
          onClick={() => comments.fetchNextPage()}
        >
          댓글 더 보기
        </Button>
      )}

      <ReportDialog
        open={reportTarget !== null}
        onClose={() => setReportTarget(null)}
        targetType="COMMENT"
        targetId={reportTarget ?? 0}
      />
    </section>
  );
}
