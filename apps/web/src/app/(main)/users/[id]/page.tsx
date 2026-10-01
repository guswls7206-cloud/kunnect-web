"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useState } from "react";
import { StartConversationDialog } from "@/components/message/start-conversation-dialog";
import { PostCard } from "@/components/post/post-card";
import { Button } from "@/components/ui/button";
import { ReportDialog } from "@/components/ui/report-dialog";
import { EmptyState, ErrorState, Spinner } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { useMe } from "@/features/auth/use-me";
import { isApiError } from "@/lib/api/client";
import { api } from "@/lib/api/endpoints";
import { parsePositiveIntId } from "@/lib/ids";

export default function UserProfilePage() {
  const parsedId = parsePositiveIntId(useParams<{ id: string }>().id);
  const id = parsedId ?? 0;
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data: me } = useMe();
  const [messaging, setMessaging] = useState(false);
  const [reporting, setReporting] = useState(false);
  const profile = useQuery({
    queryKey: ["users", id],
    queryFn: () => api.users.get(id),
    enabled: id > 0,
  });
  const posts = useInfiniteQuery({
    queryKey: ["users", id, "posts"],
    queryFn: ({ pageParam }) => api.users.posts(id, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: id > 0,
  });

  const toggleBlock = useMutation({
    mutationFn: (block: boolean) => (block ? api.blocks.add(id) : api.blocks.remove(id)),
    onSuccess: (_, block) => {
      toast.show(block ? "차단했어요. 새 쪽지와 알림이 오지 않아요." : "차단을 해제했어요.");
      queryClient.invalidateQueries({ queryKey: ["users", id] });
      queryClient.invalidateQueries({ queryKey: ["blocks"] });
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
    onError: (e) => toast.show(isApiError(e) ? e.message : "처리하지 못했습니다.", "error"),
  });

  const notFound = (
    <ErrorState
      variant="notice"
      title="사용자를 찾을 수 없어요"
      message="주소를 다시 확인해 주세요."
    />
  );
  if (parsedId === null) return notFound;
  if (profile.isPending) return <Spinner />;
  if (profile.isError) {
    return isApiError(profile.error, 404) ? (
      notFound
    ) : (
      <ErrorState message="프로필을 불러오지 못했습니다." onRetry={() => profile.refetch()} />
    );
  }

  const user = profile.data;
  const isMe = me?.id === user.id;
  const items = posts.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <section className="card flex flex-col gap-4 p-5">
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden="true"
            className="flex size-12 shrink-0 items-center justify-center rounded-full bg-brand-100 text-lg font-bold text-brand-700"
          >
            {user.nickname.slice(0, 1)}
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-bold text-slate-900">{user.nickname}</h1>
            <p className="text-sm text-slate-600">공개 글 {user.postCount}개</p>
          </div>
        </div>
        {!isMe && (
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setMessaging(true)} disabled={user.isBlockedByMe}>
              쪽지 보내기
            </Button>
            <Button
              variant="secondary"
              loading={toggleBlock.isPending}
              onClick={() => {
                if (user.isBlockedByMe) return toggleBlock.mutate(false);
                if (
                  window.confirm(`${user.nickname}님을 차단할까요? 새 쪽지와 알림이 오지 않아요.`)
                )
                  toggleBlock.mutate(true);
              }}
            >
              {user.isBlockedByMe ? "차단 해제" : "차단"}
            </Button>
            <Button variant="ghost" onClick={() => setReporting(true)}>
              신고
            </Button>
          </div>
        )}
        <StartConversationDialog
          open={messaging}
          onClose={() => setMessaging(false)}
          nickname={user.nickname}
          targetUserId={user.id}
        />
        <ReportDialog
          open={reporting}
          onClose={() => setReporting(false)}
          targetType="USER"
          targetId={user.id}
        />
      </section>

      <section aria-labelledby="user-posts" className="flex flex-col gap-3">
        <h2 id="user-posts" className="text-lg font-bold text-slate-900">
          작성한 글
        </h2>
        {posts.isPending ? (
          <Spinner />
        ) : items.length === 0 ? (
          <EmptyState title="공개된 글이 없어요" />
        ) : (
          <ul className="flex flex-col gap-3">
            {items.map((post) => (
              <PostCard key={post.id} post={post} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
