"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { TrashIcon } from "@/components/icons";
import { DeletePostDialog } from "@/components/post/delete-post-dialog";
import { PostCard } from "@/components/post/post-card";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, Spinner } from "@/components/ui/states";
import { useLogout } from "@/features/auth/use-logout";
import { useMe } from "@/features/auth/use-me";
import { useMyPosts } from "@/features/posts/queries";
import { useDeletePost } from "@/features/posts/use-delete-post";
import type { PostCardData } from "@/lib/api/types";

export default function MePage() {
  const { data: me } = useMe();
  const myPosts = useMyPosts();
  const items = myPosts.data?.pages.flatMap((p) => p.items) ?? [];
  const { logout, loggingOut } = useLogout();
  const deletePost = useDeletePost();
  const listRef = useRef<HTMLUListElement>(null);
  const [target, setTarget] = useState<PostCardData | null>(null);

  async function confirmDelete() {
    const post = target;
    if (!post) return;
    const index = items.findIndex((p) => p.id === post.id);
    setTarget(null);
    const removed = await deletePost(post.id);
    // 키보드·스크린리더 사용자가 길을 잃지 않도록 포커스를 옮긴다:
    // 삭제됐으면 같은 자리의 다음 글(없으면 이전 글, 모두 없으면 제목), 실패해 되돌렸으면 그 글의 삭제 버튼.
    requestAnimationFrame(() => {
      if (!removed) {
        listRef.current?.querySelector<HTMLElement>(`[data-delete-post-id="${post.id}"]`)?.focus();
        return;
      }
      const links = listRef.current?.querySelectorAll<HTMLElement>("a[data-post-link]");
      const next =
        links && links.length > 0 ? links[Math.min(Math.max(index, 0), links.length - 1)] : null;
      if (next) next.focus();
      else {
        const heading = document.getElementById("my-posts-heading");
        heading?.setAttribute("tabindex", "-1");
        heading?.focus();
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="내 정보" />
      <section
        aria-label="내 계정"
        className="card flex flex-wrap items-center justify-between gap-4 p-5"
      >
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden="true"
            className="flex size-12 shrink-0 items-center justify-center rounded-full bg-brand-100 text-lg font-bold text-brand-700"
          >
            {me?.nickname.slice(0, 1)}
          </span>
          <div className="min-w-0">
            <p className="text-xs text-slate-500">내 닉네임</p>
            <p className="truncate text-lg font-bold text-slate-900">{me?.nickname}</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Link
            href="/settings"
            className="inline-flex min-h-11 items-center justify-center rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition-[background-color] hover:bg-slate-50"
          >
            설정
          </Link>
          <Button variant="secondary" loading={loggingOut} onClick={logout}>
            로그아웃
          </Button>
        </div>
      </section>

      <section aria-labelledby="my-posts-heading" className="flex flex-col gap-3">
        <h2 id="my-posts-heading" className="mt-2 text-lg font-bold text-zinc-900">
          내가 쓴 글
        </h2>
        {myPosts.isPending ? (
          <Spinner />
        ) : myPosts.isError ? (
          <div className="card">
            <ErrorState
              variant="section"
              message="내 글을 불러오지 못했습니다."
              onRetry={() => myPosts.refetch()}
            />
          </div>
        ) : items.length === 0 ? (
          <EmptyState title="아직 쓴 글이 없어요" />
        ) : (
          <>
            <ul ref={listRef} className="flex flex-col gap-3">
              {items.map((post) => (
                <PostCard
                  key={post.id}
                  post={post}
                  trailing={
                    <button
                      type="button"
                      data-delete-post-id={post.id}
                      aria-label="글 삭제"
                      title={`"${post.title}" 글 삭제`}
                      onClick={() => setTarget(post)}
                      className="mr-2 flex size-11 shrink-0 items-center justify-center rounded-xl text-slate-500 transition-colors hover:bg-red-50 hover:text-red-700 focus-visible:bg-red-50 focus-visible:text-red-700"
                    >
                      <TrashIcon className="size-5" />
                    </button>
                  }
                />
              ))}
            </ul>
            {myPosts.hasNextPage && (
              <Button
                variant="secondary"
                loading={myPosts.isFetchingNextPage}
                onClick={() => myPosts.fetchNextPage()}
              >
                더 보기
              </Button>
            )}
          </>
        )}
      </section>

      <DeletePostDialog
        open={target !== null}
        onConfirm={confirmDelete}
        onCancel={() => setTarget(null)}
      />
    </div>
  );
}
