import Link from "next/link";
import type { ReactNode } from "react";
import { KunnectSearchIcon } from "@/components/brand/kunnect-logo";
import { LockOutlineIcon } from "@/components/icons";
import { Button, linkButtonClass, secondaryLinkClass } from "./button";

export function Spinner({ label = "불러오는 중" }: { label?: string }) {
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 py-10 text-sm text-zinc-500"
    >
      <span
        className="h-5 w-5 animate-spin rounded-full border-2 border-brand-100 border-t-brand-600"
        aria-hidden="true"
      />
      {label}…
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    // 그라데이션 배경 위에 떠 보이지 않도록 빈 상태는 항상 흰 카드 안에 그린다.
    <div className="card flex flex-col items-center gap-3 px-6 py-14 text-center">
      <span
        className="flex size-14 items-center justify-center rounded-full bg-brand-50"
        aria-hidden="true"
      >
        <KunnectSearchIcon className="size-9 text-brand-600" />
      </span>
      <p className="text-base font-semibold text-zinc-800">{title}</p>
      {description && <p className="text-sm text-zinc-500">{description}</p>}
      {action}
    </div>
  );
}

interface ErrorStateProps {
  message: string;
  onRetry?: () => void;
  /**
   * page: 화면 전체를 대신하는 오류(글을 찾을 수 없음 등). 카드 안에 h1 제목과 "홈으로" 링크를 함께 보여 준다.
   * section: 목록·댓글처럼 화면 일부의 오류. 제목 없이 메시지와 다시 시도만 보여 준다(h1 이 중복되지 않게).
   * notice: 오류가 아닌 안내(API 404 로 대상이 없음, 남의 글이라 권한 없음 등). 빨간색 대신 중립 톤과 주요 버튼 하나를 쓴다.
   */
  variant?: "page" | "section" | "notice";
  /** page·notice 일 때의 제목 */
  title?: string;
  /** notice 의 주요 버튼(기본: 홈으로 "/") */
  action?: { href: string; label: string };
  /** notice 의 아이콘. search: 가방+돋보기(찾을 수 없음, 기본), lock: 자물쇠(권한 없음) */
  icon?: "search" | "lock";
}

const HOME_ACTION = { href: "/", label: "홈으로" };

export function ErrorState({
  message,
  onRetry,
  variant = "page",
  title,
  action = HOME_ACTION,
  icon = "search",
}: ErrorStateProps) {
  if (variant === "notice") {
    // app/not-found.tsx 와 같은 모양(아이콘 + 제목 + 설명 + 주요 버튼). 화면 안 카드라 크기만 줄였다.
    return (
      <div className="card flex flex-col items-center px-6 py-12 text-center">
        <span
          className="flex size-16 items-center justify-center rounded-full bg-brand-50"
          aria-hidden="true"
        >
          {icon === "lock" ? (
            <LockOutlineIcon className="size-9 text-brand-600" />
          ) : (
            <KunnectSearchIcon className="size-11 text-brand-600" />
          )}
        </span>
        <h1 className="mt-4 text-xl font-bold text-zinc-900">
          {title ?? "페이지를 찾을 수 없어요"}
        </h1>
        <p className="mt-2 text-sm text-zinc-600">{message}</p>
        <Link href={action.href} className={`${linkButtonClass} mt-6 min-w-32`}>
          {action.label}
        </Link>
      </div>
    );
  }

  const retry = onRetry && (
    <Button variant="secondary" onClick={onRetry}>
      다시 시도
    </Button>
  );

  if (variant === "section") {
    return (
      <div role="alert" className="flex flex-col items-center gap-3 px-6 py-14 text-center">
        <p className="text-sm text-red-700">{message}</p>
        {retry}
      </div>
    );
  }

  return (
    <div className="card flex flex-col items-center gap-3 px-6 py-14 text-center">
      <h1 className="text-lg font-bold text-zinc-900">{title ?? "문제가 발생했어요"}</h1>
      <p role="alert" className="text-sm text-red-700">
        {message}
      </p>
      <div className="mt-2 flex flex-wrap justify-center gap-2">
        {retry}
        <Link href="/" className={secondaryLinkClass}>
          홈으로
        </Link>
      </div>
    </div>
  );
}

export function PostCardSkeleton() {
  return (
    <div className="card flex animate-pulse gap-3 p-3" aria-hidden="true">
      <div className="h-20 w-20 shrink-0 rounded-lg bg-zinc-200" />
      <div className="flex flex-1 flex-col gap-2 py-1">
        <div className="h-4 w-3/4 rounded bg-zinc-200" />
        <div className="h-3 w-1/2 rounded bg-zinc-200" />
        <div className="h-3 w-1/3 rounded bg-zinc-200" />
      </div>
    </div>
  );
}
