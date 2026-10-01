"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { TrashIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, ErrorState, Spinner } from "@/components/ui/states";
import { useInbox } from "@/features/messages/queries";
import { useDeleteConversation } from "@/features/messages/use-delete-conversation";
import type { ConversationItem } from "@/lib/api/types";
import { relativeTime } from "@/lib/format";

export default function MessagesPage() {
  const inbox = useInbox();
  const deleteConversation = useDeleteConversation();
  const items = inbox.data?.pages.flatMap((p) => p.items) ?? [];
  const listRef = useRef<HTMLUListElement>(null);
  const [target, setTarget] = useState<ConversationItem | null>(null);

  function focusHeading() {
    const heading = document.getElementById("inbox-heading");
    heading?.setAttribute("tabindex", "-1");
    heading?.focus();
  }

  async function confirmDelete() {
    const conv = target;
    if (!conv) return;
    const index = items.findIndex((c) => c.id === conv.id);
    setTarget(null);
    const removed = await deleteConversation(conv.id);
    // 키보드·스크린리더 사용자가 길을 잃지 않도록 포커스를 옮긴다:
    // 삭제됐으면 같은 자리의 다음 대화(없으면 이전 대화, 모두 없으면 제목), 실패해 되돌렸으면 그 대화의 삭제 버튼.
    requestAnimationFrame(() => {
      if (!removed) {
        listRef.current?.querySelector<HTMLElement>(`[data-delete-id="${conv.id}"]`)?.focus();
        return;
      }
      const links = listRef.current?.querySelectorAll<HTMLElement>("a[data-conv-link]");
      const next =
        links && links.length > 0 ? links[Math.min(Math.max(index, 0), links.length - 1)] : null;
      if (next) next.focus();
      else focusHeading();
    });
  }

  return (
    <section aria-labelledby="inbox-heading" className="flex flex-col gap-4">
      <PageHeader id="inbox-heading" title="쪽지함" />
      {inbox.isPending ? (
        <Spinner />
      ) : inbox.isError ? (
        <div className="card">
          <ErrorState
            variant="section"
            message="쪽지함을 불러오지 못했습니다."
            onRetry={() => inbox.refetch()}
          />
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          title="아직 쪽지가 없어요"
          description="글이나 프로필에서 쪽지를 보낼 수 있어요."
        />
      ) : (
        <ul ref={listRef} className="flex flex-col gap-3">
          {items.map((c) => (
            <li key={c.id}>
              {/* 카드 전체는 div, 그 안에 링크(대화 열기)와 삭제 버튼을 나란히 둔다: 링크 안에 버튼을 넣지 않는다. */}
              <div
                className={`flex items-center rounded-2xl border shadow-card transition-[border-color] hover:border-brand-400 ${
                  c.unread > 0 ? "border-brand-300 bg-brand-50" : "border-slate-200/70 bg-white"
                }`}
              >
                <Link
                  href={`/messages/${c.id}`}
                  data-conv-link
                  className="flex min-h-16 min-w-0 flex-1 items-center gap-3 rounded-2xl p-4"
                >
                  <span
                    aria-hidden="true"
                    className="flex size-11 shrink-0 items-center justify-center rounded-full bg-brand-100 text-base font-bold text-brand-700"
                  >
                    {c.other.nickname.slice(0, 1)}
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-base font-semibold text-slate-900">
                        {c.other.nickname}
                      </span>
                      {c.muted && <span className="text-xs text-slate-600">음소거</span>}
                      {c.readOnly && (
                        <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600 ring-1 ring-slate-200 ring-inset">
                          읽기 전용
                        </span>
                      )}
                    </div>
                    {c.postContext && (
                      <span className="truncate text-sm text-slate-600">
                        관련 글: {c.postContext.title}
                      </span>
                    )}
                    {c.lastMessage && (
                      <span className="text-xs text-slate-600">
                        {relativeTime(c.lastMessage.createdAt)}
                      </span>
                    )}
                  </div>
                  {c.unread > 0 && (
                    <span
                      aria-label={`읽지 않은 쪽지 ${c.unread}개`}
                      className="min-w-6 rounded-full bg-red-600 px-2 py-0.5 text-center text-xs font-bold text-white"
                    >
                      {c.unread}
                    </span>
                  )}
                </Link>
                <button
                  type="button"
                  data-delete-id={c.id}
                  aria-label="대화 삭제"
                  title={`${c.other.nickname}님과의 대화 삭제`}
                  onClick={() => setTarget(c)}
                  className="mr-2 flex size-11 shrink-0 items-center justify-center rounded-xl text-slate-500 transition-colors hover:bg-red-50 hover:text-red-700 focus-visible:bg-red-50 focus-visible:text-red-700"
                >
                  <TrashIcon className="size-5" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {inbox.hasNextPage && (
        <Button
          variant="secondary"
          loading={inbox.isFetchingNextPage}
          onClick={() => inbox.fetchNextPage()}
        >
          더 보기
        </Button>
      )}

      <ConfirmDialog
        open={target !== null}
        title="이 대화를 삭제할까요?"
        description="내 쪽지함에서만 삭제되며 상대방에게는 영향이 없습니다. 상대방이 새 메시지를 보내면 그 이후 내용부터 다시 표시됩니다."
        confirmLabel="삭제"
        onConfirm={confirmDelete}
        onCancel={() => setTarget(null)}
      />
    </section>
  );
}
