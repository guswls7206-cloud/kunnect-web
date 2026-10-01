"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { StartConversationDialog } from "@/components/message/start-conversation-dialog";
import { PostCard } from "@/components/post/post-card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, ErrorState, Spinner } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { postKeys, usePostDetail } from "@/features/posts/queries";
import { isApiError } from "@/lib/api/client";
import { api } from "@/lib/api/endpoints";
import { parsePositiveIntId } from "@/lib/ids";
import type { MatchItem } from "@/lib/api/types";

const GRADE_LABEL: Record<MatchItem["grade"], string> = {
  HIGH: "매우 비슷해요",
  MID: "비슷할 수 있어요",
};
const DIFF_LABEL: Record<MatchItem["locationDiff"], string> = {
  SAME_PLACE: "같은 장소",
  SAME_BUILDING: "같은 건물",
  NEARBY: "가까운 곳",
  FAR: "다소 먼 곳",
};

function MatchCard({
  match,
  canDecide,
  postId,
}: {
  match: MatchItem;
  canDecide: boolean;
  postId: number;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [messaging, setMessaging] = useState(false);
  const decide = useMutation({
    mutationFn: (action: "confirm" | "reject") =>
      action === "confirm" ? api.matches.confirm(match.matchId) : api.matches.reject(match.matchId),
    onSuccess: (_, action) => {
      queryClient.invalidateQueries({ queryKey: ["matches", postId] });
      queryClient.invalidateQueries({ queryKey: postKeys.all });
      toast.show(
        action === "confirm"
          ? "내 물건으로 확인했어요. 습득자에게 연락해 보세요."
          : "후보에서 제외했어요.",
      );
    },
    onError: (e) => {
      toast.show(isApiError(e) ? e.message : "처리하지 못했습니다.", "error");
      // 이미 다른 기기에서 선택한 경우 최신 상태로 맞춘다.
      queryClient.invalidateQueries({ queryKey: ["matches", postId] });
    },
  });

  return (
    <li className="card flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        {/* 등급은 색뿐 아니라 문구로도 전달한다(점수는 노출하지 않는다). */}
        <span
          className={`rounded-md px-2 py-0.5 text-xs font-bold ${match.grade === "HIGH" ? "bg-brand-600 text-white" : "bg-brand-50 text-brand-700 ring-1 ring-brand-200 ring-inset"}`}
        >
          {GRADE_LABEL[match.grade]}
        </span>
        <span className="text-xs text-zinc-600">위치: {DIFF_LABEL[match.locationDiff]}</span>
      </div>
      <ul>
        <PostCard post={match.otherPost} flat />
      </ul>
      {match.aiReason && (
        <p className="rounded-xl bg-zinc-50 px-4 py-3 text-sm leading-relaxed text-zinc-700 ring-1 ring-zinc-200/70 ring-inset">
          <span className="font-semibold text-zinc-900">AI 의견</span> {match.aiReason}
        </p>
      )}
      {match.status === "CONFIRMED" && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-brand-50 px-4 py-3">
          <span className="text-sm font-semibold text-brand-700">내 것으로 확인함</span>
          <Button onClick={() => setMessaging(true)}>
            {canDecide ? "습득자" : "분실자"}에게 쪽지 보내기
          </Button>
          <StartConversationDialog
            open={messaging}
            onClose={() => setMessaging(false)}
            nickname={match.otherPost.author.nickname}
            targetUserId={match.otherPost.author.id}
            postId={match.otherPost.id}
          />
        </div>
      )}
      {canDecide && match.status === "PENDING" && (
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="secondary"
            loading={decide.isPending && decide.variables === "reject"}
            disabled={decide.isPending}
            onClick={() => decide.mutate("reject")}
          >
            아니에요
          </Button>
          <Button
            loading={decide.isPending && decide.variables === "confirm"}
            disabled={decide.isPending}
            onClick={() => decide.mutate("confirm")}
          >
            내 것이 맞아요
          </Button>
        </div>
      )}
    </li>
  );
}

export default function MatchesPage() {
  const parsedId = parsePositiveIntId(useParams<{ id: string }>().id);
  const postId = parsedId ?? 0;
  const { data: post } = usePostDetail(postId);
  const matches = useQuery({
    queryKey: ["matches", postId],
    queryFn: () => api.matches.forPost(postId),
    enabled: postId > 0,
    // 매칭이 진행 중이면 끝날 때까지 폴링한다.
    refetchInterval: (q) => (q.state.data?.matchState === "PENDING" ? 4_000 : false),
  });

  const notFound = (
    <ErrorState
      variant="notice"
      title="게시글을 찾을 수 없어요"
      message="삭제되었거나 주소가 잘못되었어요."
    />
  );
  if (parsedId === null) return notFound;
  if (matches.isPending) return <Spinner />;
  if (matches.isError) {
    if (isApiError(matches.error, 404)) return notFound;
    // 남의 글(403)은 오류가 아니라 권한 안내이므로 중립 톤으로 보여 준다.
    return isApiError(matches.error, 403) ? (
      <ErrorState
        variant="notice"
        title="매칭 결과를 볼 수 없어요"
        icon="lock"
        action={{ href: `/posts/${postId}`, label: "글로 돌아가기" }}
        message="내가 쓴 글의 매칭 결과만 볼 수 있어요."
      />
    ) : (
      <ErrorState message="매칭 결과를 불러오지 못했습니다." onRetry={() => matches.refetch()} />
    );
  }

  const { matchState, items } = matches.data;
  // 확인·제외는 분실글 작성자만 할 수 있다(습득글에서는 "비슷한 분실글"을 보기만 한다).
  const canDecide = post?.type === "LOST";

  return (
    <section aria-labelledby="match-heading" className="flex flex-col gap-4">
      <Link
        href={`/posts/${postId}`}
        className="self-start rounded text-sm font-medium text-brand-700 underline-offset-2 hover:underline"
      >
        ← 내 글로 돌아가기
      </Link>
      <PageHeader
        id="match-heading"
        title={post?.type === "FOUND" ? "비슷한 분실글" : "비슷한 습득글"}
        subtitle={post && <span className="block truncate">내 글: {post.title}</span>}
      />

      {matchState === "PENDING" && (
        <p
          role="status"
          className="rounded-xl bg-brand-50 px-4 py-3 text-sm font-medium text-brand-700"
        >
          비슷한 글을 찾는 중이에요. 잠시만 기다려 주세요…
        </p>
      )}
      {matchState === "FAILED" && (
        <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
          비슷한 글을 찾지 못했어요. 잠시 후 다시 확인해 주세요.
        </p>
      )}

      {items.length === 0 ? (
        matchState === "DONE" && (
          <EmptyState
            title="아직 비슷한 글이 없어요"
            description="비슷한 글이 올라오면 알림으로 알려 드릴게요."
          />
        )
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((m) => (
            <MatchCard key={m.matchId} match={m} canDecide={canDecide} postId={postId} />
          ))}
        </ul>
      )}
    </section>
  );
}
