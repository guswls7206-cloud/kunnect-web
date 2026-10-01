import { KunnectSearchIcon, KunnectWordmark } from "@/components/brand/kunnect-logo";
import { GuestOnly } from "@/components/layout/guest-only";

/** 회원가입 화면: 로그인 화면의 오른쪽 카드와 같은 모양(가운데 흰 카드 + 원형 아이콘 + 워드마크 제목). */
export default function SignupLayout({ children }: { children: React.ReactNode }) {
  // 이미 로그인한 사용자는 메인으로 보낸다(GuestOnly).
  return (
    <GuestOnly>
      <main className="flex min-h-screen w-full flex-col items-center justify-center px-4 py-8 break-keep sm:px-6 lg:py-10">
        <div className="w-full max-w-xl rounded-3xl bg-white px-5 py-8 shadow-xl shadow-zinc-900/5 sm:px-12 sm:py-12">
          <div className="flex flex-col items-center text-center">
            <div className="flex size-20 items-center justify-center rounded-full bg-brand-50 sm:size-24">
              <KunnectSearchIcon className="size-14 text-brand-600 sm:size-16" />
            </div>
            <h1 className="mt-5 flex items-baseline gap-2 text-3xl sm:text-4xl">
              <KunnectWordmark /> <span className="font-bold text-zinc-900">회원가입</span>
            </h1>
            <p className="mt-3 text-sm text-zinc-600 sm:text-base">
              잃어버린 물건과 주운 물건을 AI가 이어드려요.
            </p>
          </div>

          <div className="mt-8">{children}</div>

          <p className="mt-8 text-center text-xs text-zinc-500">
            © {new Date().getFullYear()} KUnnect. All rights reserved.
          </p>
        </div>
      </main>
    </GuestOnly>
  );
}
