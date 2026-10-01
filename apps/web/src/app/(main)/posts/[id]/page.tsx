"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { CommentSection } from "@/components/comment/comment-section";
import { StartConversationDialog } from "@/components/message/start-conversation-dialog";
import { DeletePostDialog } from "@/components/post/delete-post-dialog";
import { PhotoCarousel } from "@/components/post/photo-carousel";
import { StatusBadge, TypeBadge } from "@/components/ui/badge";
import { Button, linkButtonClass, secondaryLinkClass } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ReportDialog } from "@/components/ui/report-dialog";
import { ErrorState, Spinner } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { postKeys, usePostDetail } from "@/features/posts/queries";
import { useDeletePost } from "@/features/posts/use-delete-post";
import { isApiError } from "@/lib/api/client";
import { api } from "@/lib/api/endpoints";
import { formatDateTime, formatLocation, relativeTime } from "@/lib/format";
import { parsePositiveIntId } from "@/lib/ids";

export default function PostDetailPage() {
  const params = useParams<{ id: string }>();
  // 올바르지 않은 id 는 0 으로 두어 조회를 하지 않고, 아래에서 바로 "찾을 수 없음"을 보여 준다.
  const parsedId = parsePositiveIntId(params.id);
  const id = parsedId ?? 0;
  const router = useRouter();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [reporting, setReporting] = useState(false);
  const [messaging, setMessaging] = useState(false);
  const [confirming, setConfirming] = useState<"close" | "delete" | null>(null);
  const deletePost = useDeletePost();
  const { data: post, isPending, error, refetch } = usePostDetail(id);

  const close = useMutation({
    mutationFn: () => api.posts.setStatus(id, "CLOSED"),
    onSuccess: (updated) => {
      queryClient.setQueryData(postKeys.detail(id), updated);
      queryClient.invalidateQueries({ queryKey: postKeys.all });
      toast.show("글을 종료했어요.");
    },
    onError: (e) => toast.show(isApiError(e) ? e.message : "처리하지 못했습니다.", "error"),
  });

  const notFound = (
    <ErrorState
      variant="notice"
      title="게시글을 찾을 수 없어요"
      message="삭제되었거나 주소가 잘못되었어요."
    />
  );
  if (parsedId === null) return notFound;
  if (isPending) return <Spinner />;
  if (error || !post) {
    return isApiError(error, 404) ? (
      notFound
    ) : (
      <ErrorState message="글을 불러오지 못했습니다." onRetry={() => refetch()} />
    );
  }

  const ended = post.status === "CLOSED" || post.status === "RETURNED";

  return (
    <article className="flex flex-col gap-4">
      <div className="card flex flex-col gap-5 p-4 sm:p-6">
        <PhotoCarousel photos={post.photos} title={post.title} />

        <header className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <TypeBadge type={post.type} />
            <StatusBadge status={post.status} />
            {post.matchState === "PENDING" && (
              <span
                role="status"
                className="rounded-md bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700"
              >
                비슷한 글을 찾는 중…
              </span>
            )}
          </div>
          <h1 className="text-2xl leading-snug font-bold text-zinc-900">{post.title}</h1>
          <p className="text-sm text-zinc-500">
            <Link
              href={`/users/${post.author.id}`}
              className="rounded font-semibold text-zinc-700 underline-offset-2 hover:text-brand-700 hover:underline"
            >
              {post.author.nickname}
            </Link>{" "}
            · {relativeTime(post.createdAt)}
          </p>
        </header>

        <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-2.5 rounded-xl bg-zinc-50 p-4 text-sm ring-1 ring-zinc-200/70 ring-inset">
          <dt className="text-zinc-500">{post.type === "LOST" ? "분실 위치" : "습득 위치"}</dt>
          <dd className="font-medium text-zinc-900">
            {formatLocation(
              post.location.floor
                ? `${post.location.buildingName} ${post.location.floor}층`
                : post.location.buildingName,
              post.locationText,
            )}
          </dd>
          <dt className="text-zinc-500">{post.type === "LOST" ? "분실 일시" : "습득 일시"}</dt>
          <dd className="font-medium text-zinc-900">{formatDateTime(post.occurredAt)}</dd>
          {post.type === "FOUND" && post.storagePlace && (
            <>
              <dt className="text-zinc-500">보관 장소</dt>
              <dd className="font-medium text-zinc-900">{post.storagePlace}</dd>
            </>
          )}
          {post.tags.length > 0 && (
            <>
              <dt className="text-zinc-500">태그</dt>
              <dd>
                <ul className="flex flex-wrap gap-1.5">
                  {post.tags.map((tag) => (
                    <li
                      key={tag}
                      className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-medium text-brand-700"
                    >
                      #{tag}
                    </li>
                  ))}
                </ul>
              </dd>
            </>
          )}
        </dl>

        <p className="text-base leading-relaxed whitespace-pre-wrap text-zinc-800">
          {post.description}
        </p>

        {post.isMine && post.hiddenFeatures && (
          <p className="rounded-xl border border-dashed border-zinc-300 bg-zinc-50 p-4 text-sm text-zinc-700">
            <span className="mb-1 block text-xs font-semibold text-zinc-500">
              비공개 특징 (나에게만 보여요)
            </span>
            {post.hiddenFeatures}
          </p>
        )}

        <div className="border-t border-zinc-100 pt-5">
          {post.isMine ? (
            // 모바일: 주요 버튼 한 줄 + 나머지 버튼을 같은 너비 격자로. sm 이상: 한 줄, 삭제는 오른쪽 끝.
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Link
                href={`/posts/${post.id}/matches`}
                className={`${linkButtonClass} w-full sm:w-auto`}
              >
                비슷한 글 보기
              </Link>
              <div
                className={`grid gap-2 sm:flex sm:flex-1 sm:items-center ${ended ? "grid-cols-1" : "grid-cols-3"}`}
              >
                {!ended && (
                  <>
                    <Link href={`/posts/${post.id}/edit`} className={secondaryLinkClass}>
                      수정
                    </Link>
                    <Button
                      variant="secondary"
                      loading={close.isPending}
                      onClick={() => setConfirming("close")}
                    >
                      종료
                    </Button>
                  </>
                )}
                <Button
                  variant="danger"
                  className="sm:ml-auto"
                  onClick={() => setConfirming("delete")}
                >
                  삭제
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Button onClick={() => setMessaging(true)}>쪽지 보내기</Button>
              <StartConversationDialog
                open={messaging}
                onClose={() => setMessaging(false)}
                nickname={post.author.nickname}
                postId={post.id}
              />
              <Button variant="ghost" className="ml-auto" onClick={() => setReporting(true)}>
                신고
              </Button>
              <ReportDialog
                open={reporting}
                onClose={() => setReporting(false)}
                targetType="POST"
                targetId={post.id}
              />
            </div>
          )}
        </div>
      </div>

      <CommentSection postId={post.id} closed={ended} postAuthorId={post.author.id} />

      {post.isMine && (
        <>
          <ConfirmDialog
            open={confirming === "close"}
            title="이 글을 종료할까요?"
            description="종료하면 더 이상 수정할 수 없어요. 종료한 글은 일정 시간 뒤 자동으로 삭제돼요."
            confirmLabel="종료"
            tone="primary"
            onConfirm={() => {
              setConfirming(null);
              close.mutate();
            }}
            onCancel={() => setConfirming(null)}
          />
          <DeletePostDialog
            open={confirming === "delete"}
            onConfirm={() => {
              setConfirming(null);
              // 삭제가 끝나면 내 정보(내가 쓴 글)로 이동한다. 이 글의 상세는 더 이상 없다.
              void deletePost(post.id, { onDeleted: () => router.replace("/me") });
            }}
            onCancel={() => setConfirming(null)}
          />
        </>
      )}
    </article>
  );
}
