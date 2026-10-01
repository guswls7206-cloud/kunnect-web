import type { Metadata } from "next";
import Link from "next/link";
import { KunnectSearchIcon, KunnectWordmark } from "@/components/brand/kunnect-logo";
import { linkButtonClass } from "@/components/ui/button";

export const metadata: Metadata = { title: "페이지를 찾을 수 없어요" };

/** 없는 주소로 들어왔을 때의 화면(로그인 카드와 같은 모양) */
export default function NotFound() {
  return (
    <main className="flex min-h-screen w-full items-center justify-center px-4 py-8 break-keep">
      <div className="flex w-full max-w-md flex-col items-center rounded-3xl bg-white px-6 py-10 text-center shadow-xl shadow-zinc-900/5 sm:px-10">
        <div className="flex size-20 items-center justify-center rounded-full bg-brand-50">
          <KunnectSearchIcon className="size-14 text-brand-600" />
        </div>
        <p className="mt-5 text-sm font-semibold text-brand-600">404</p>
        <h1 className="mt-1 text-2xl font-bold text-zinc-900">페이지를 찾을 수 없어요</h1>
        <p className="mt-2 text-sm text-zinc-600">주소가 잘못되었거나 삭제된 페이지예요.</p>
        <Link href="/" className={`${linkButtonClass} mt-6 w-full`}>
          홈으로
        </Link>
        <p className="mt-6 text-xs text-zinc-500">
          <KunnectWordmark />
        </p>
      </div>
    </main>
  );
}
