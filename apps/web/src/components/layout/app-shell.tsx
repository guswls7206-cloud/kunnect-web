"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useMe } from "@/features/auth/use-me";
import { useUnreadCounts } from "@/features/auth/use-unread";
import { KunnectLogoIcon, KunnectWordmark } from "@/components/brand/kunnect-logo";
import { BellIcon, ChatIcon, HomeIcon, PencilIcon, UserOutlineIcon } from "@/components/icons";
import { CountBadge, UnreadSrText } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/states";

/** 경로가 base 자체이거나 그 하위 경로인지. "/me" 가 "/messages" 와 겹치지 않도록 접두어 비교에 "/" 경계를 둔다. */
export function inSection(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

export const NAV = [
  { href: "/", label: "홈", Icon: HomeIcon, match: (p: string) => p === "/" },
  {
    href: "/posts/new",
    label: "글쓰기",
    Icon: PencilIcon,
    match: (p: string) => inSection(p, "/posts/new"),
  },
  {
    href: "/notifications",
    label: "알림",
    Icon: BellIcon,
    match: (p: string) => inSection(p, "/notifications"),
    badge: "notifications" as const,
  },
  {
    href: "/messages",
    label: "쪽지",
    Icon: ChatIcon,
    match: (p: string) => inSection(p, "/messages"),
    badge: "messages" as const,
  },
  {
    href: "/me",
    label: "내 정보",
    Icon: UserOutlineIcon,
    match: (p: string) => inSection(p, "/me") || inSection(p, "/settings"),
  },
];

/** 로그인한 사용자 영역의 공통 레이아웃. 미로그인이면 로그인 화면으로 보낸다. */
export function AppShell({ children }: { children: ReactNode }) {
  const { data: me, isPending, isFetching, isError, refetch } = useMe();
  const unread = useUnreadCounts();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    // 재조회 중인 낡은 null 값으로 잘못 리다이렉트하지 않도록 조회가 끝난 뒤에만 이동한다.
    if (me === null && !isFetching) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [me, isFetching, pathname, router]);

  if (isError) {
    return (
      <div
        role="alert"
        className="bg-page-ku flex min-h-screen flex-col items-center gap-3 py-20 text-sm text-red-700"
      >
        서버에 연결하지 못했습니다.
        <Button variant="secondary" onClick={() => refetch()}>
          다시 시도
        </Button>
      </div>
    );
  }

  if (isPending || me === null || me === undefined) {
    // 로딩 중에도 메인 화면과 같은 배경을 써서 파란 배경이 잠깐 비치지 않게 한다.
    return (
      <div className="bg-page-ku min-h-screen">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="bg-page-ku flex min-h-screen w-full flex-col">
      <header className="sticky top-0 z-30 border-b border-zinc-200/70 bg-white/85 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-2xl items-center justify-between px-4">
          <Link href="/" aria-label="KUnnect 홈" className="flex items-center gap-2 rounded-lg">
            {/* 로그인 화면과 같은 로고 색: 아이콘·"KU"는 KU 초록(text-ku-green), "nnect"는 짙은 남색(워드마크 기본) */}
            <KunnectLogoIcon className="size-8 text-ku-green" />
            <KunnectWordmark className="text-xl" kuClassName="text-ku-green" />
          </Link>
          <nav aria-label="주요 메뉴" className="hidden items-center gap-1 md:flex">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={item.match(pathname) ? "page" : undefined}
                className={`inline-flex min-h-11 items-center rounded-lg px-3 py-2.5 text-sm font-medium transition-[background-color,color] ${
                  item.match(pathname)
                    ? "bg-brand-50 font-semibold text-brand-700 hover:bg-brand-100"
                    : "text-zinc-600 hover:bg-zinc-200/60 hover:text-zinc-900"
                }`}
              >
                {item.label}
                {item.badge && <CountBadge count={unread[item.badge]} placement="inline" />}
              </Link>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 px-4 pt-5 pb-24 md:pb-10">{children}</main>

      <nav
        aria-label="하단 메뉴"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-zinc-200/70 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
      >
        <ul className="mx-auto flex max-w-2xl">
          {NAV.map(({ Icon, ...item }) => (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={item.match(pathname) ? "page" : undefined}
                className={`relative flex min-h-(--bottom-nav-h) flex-col items-center justify-center gap-1 text-xs font-medium ${
                  item.match(pathname) ? "text-brand-600" : "text-zinc-600"
                }`}
              >
                <span className="relative">
                  <Icon className="size-6" />
                  {item.badge && <CountBadge count={unread[item.badge]} srText={false} />}
                </span>
                {item.label}
                {item.badge && <UnreadSrText count={unread[item.badge]} />}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
