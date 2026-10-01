"use client";

import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, ErrorState, Spinner } from "@/components/ui/states";
import { BADGE_POLL_MS } from "@/features/auth/use-me";
import { unreadKey } from "@/features/auth/use-unread";
import { api } from "@/lib/api/endpoints";
import { relativeTime } from "@/lib/format";
import { notificationHref } from "@/lib/notification-target";

const TYPE_LABEL = { MATCH: "매칭", COMMENT: "댓글", REPLY: "답글", MESSAGE: "쪽지" } as const;
const key = ["notifications"] as const;

export default function NotificationsPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const list = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }) => api.notifications.list(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    // 화면이 열려 있는 동안 주기적으로 새 알림을 확인한다(탭이 가려지면 자동 중지).
    refetchInterval: BADGE_POLL_MS,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const unread = list.data?.pages[0]?.unreadCount ?? 0;

  function refreshBadges() {
    queryClient.invalidateQueries({ queryKey: key });
    queryClient.invalidateQueries({ queryKey: unreadKey });
  }

  async function open(id: number, href: string, alreadyRead: boolean) {
    // 읽음 처리 실패가 이동을 막지 않도록 결과를 기다리지 않는다.
    if (!alreadyRead)
      api.notifications
        .read(id)
        .then(refreshBadges)
        .catch(() => undefined);
    router.push(href);
  }

  async function readAll() {
    await api.notifications.readAll().catch(() => undefined);
    refreshBadges();
  }

  return (
    <section aria-labelledby="noti-heading" className="flex flex-col gap-4">
      <PageHeader
        id="noti-heading"
        title="알림"
        actions={
          <Button variant="ghost" disabled={unread === 0} onClick={readAll}>
            모두 읽음
          </Button>
        }
      />

      {list.isPending ? (
        <Spinner />
      ) : list.isError ? (
        <div className="card">
          <ErrorState
            variant="section"
            message="알림을 불러오지 못했습니다."
            onRetry={() => list.refetch()}
          />
        </div>
      ) : items.length === 0 ? (
        <EmptyState title="아직 알림이 없어요" description="비슷한 글이 올라오면 알려 드릴게요." />
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                onClick={() => open(n.id, notificationHref(n), Boolean(n.readAt))}
                className={`flex w-full min-h-16 items-start gap-3 rounded-2xl border p-4 text-left shadow-card transition-[border-color] hover:border-brand-400 ${
                  n.readAt ? "border-slate-200/70 bg-white" : "border-brand-300 bg-brand-50"
                }`}
              >
                <span
                  className={`mt-0.5 shrink-0 rounded-md px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${
                    n.readAt
                      ? "bg-slate-100 text-slate-600 ring-slate-200"
                      : "bg-white text-brand-700 ring-brand-200"
                  }`}
                >
                  {TYPE_LABEL[n.type]}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span
                    className={`text-sm leading-relaxed ${n.readAt ? "text-slate-700" : "font-semibold text-slate-900"}`}
                  >
                    {n.text}
                  </span>
                  <span className="text-xs text-slate-600">
                    {relativeTime(n.createdAt)}
                    {!n.readAt && (
                      <span className="ml-2 font-semibold text-brand-700">· 읽지 않음</span>
                    )}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {list.hasNextPage && (
        <Button
          variant="secondary"
          loading={list.isFetchingNextPage}
          onClick={() => list.fetchNextPage()}
        >
          더 보기
        </Button>
      )}
    </section>
  );
}
