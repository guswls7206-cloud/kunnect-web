import type { Metadata } from "next";
import { KunnectLogoIcon, KunnectWordmark } from "@/components/brand/kunnect-logo";
import { linkButtonClass } from "@/components/ui/button";

export const metadata: Metadata = { title: "오프라인" };

/** 서비스워커가 네트워크 실패 시 보여주는 안내 페이지 */
export default function OfflinePage() {
  return (
    <main className="flex min-h-screen w-full items-center justify-center px-4 py-8 break-keep">
      <div className="flex w-full max-w-md flex-col items-center rounded-3xl bg-white px-6 py-10 text-center shadow-xl shadow-zinc-900/5 sm:px-10">
        <div className="flex items-center gap-2">
          <KunnectLogoIcon className="size-10 text-brand-600" />
          <KunnectWordmark className="text-2xl" />
        </div>
        <h1 className="mt-6 text-xl font-bold text-zinc-900">인터넷에 연결되어 있지 않아요</h1>
        <p className="mt-2 text-sm text-zinc-600">연결 상태를 확인한 뒤 다시 시도해 주세요.</p>
        {/* 일반 링크로 전체 새로고침해 서비스워커가 다시 네트워크를 시도하게 한다(클라이언트 이동은 오프라인 화면에 머문다). */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a href="/" className={`${linkButtonClass} mt-6 w-full`}>
          다시 시도
        </a>
      </div>
    </main>
  );
}
