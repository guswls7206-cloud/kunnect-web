import Link from "next/link";
import type { ReactNode } from "react";
import { StatusBadge, TypeBadge } from "@/components/ui/badge";
import type { PostCardData } from "@/lib/api/types";
import { formatLocation, relativeTime } from "@/lib/format";

interface PostCardProps {
  post: PostCardData;
  /** 다른 카드 안에 들어갈 때(매칭 결과 등) 그림자 없이 테두리만 쓴다. */
  flat?: boolean;
  /**
   * 카드 오른쪽에 둘 요소(예: 삭제 버튼). 주면 카드 전체는 div 가 되고 링크와 이 요소가 나란히 놓인다.
   * (링크 안에 버튼을 넣으면 유효하지 않은 HTML 이라 형제로 둔다.)
   */
  trailing?: ReactNode;
}

export function PostCard({ post, flat = false, trailing }: PostCardProps) {
  const body = (
    <>
      {post.thumbnailUrl ? (
        // 사용자 업로드 이미지(서버/데이터 URL)라 next/image 최적화를 쓰지 않는다.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={post.thumbnailUrl}
          alt=""
          className="size-20 shrink-0 rounded-xl bg-zinc-100 object-cover"
          width={80}
          height={80}
        />
      ) : (
        <div
          aria-hidden="true"
          className="flex size-20 shrink-0 items-center justify-center rounded-xl bg-zinc-100 text-xs text-zinc-600"
        >
          사진 없음
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-1.5">
          <TypeBadge type={post.type} />
          <StatusBadge status={post.status} />
        </div>
        <h2 className="truncate text-base font-semibold text-zinc-900">{post.title}</h2>
        <p className="truncate text-sm text-zinc-600">
          {formatLocation(post.locationName, post.locationText)} · {relativeTime(post.occurredAt)}
        </p>
        {post.tags.length > 0 && (
          <p className="truncate text-xs text-zinc-500">
            {post.tags.map((t) => `#${t}`).join(" ")}
          </p>
        )}
      </div>
    </>
  );

  const surface = flat ? "rounded-xl border border-zinc-200 bg-white" : "card hover:shadow-md";

  if (trailing) {
    return (
      <li>
        <div
          className={`flex items-center transition-[border-color,box-shadow] hover:border-brand-300 ${surface}`}
        >
          <Link
            href={`/posts/${post.id}`}
            data-post-link
            className="flex min-w-0 flex-1 gap-4 rounded-2xl p-4"
          >
            {body}
          </Link>
          {trailing}
        </div>
      </li>
    );
  }

  return (
    <li>
      <Link
        href={`/posts/${post.id}`}
        className={`flex gap-4 p-4 transition-[border-color,box-shadow] hover:border-brand-300 ${surface}`}
      >
        {body}
      </Link>
    </li>
  );
}
