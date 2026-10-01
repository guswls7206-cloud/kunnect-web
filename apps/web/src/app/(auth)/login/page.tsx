import { existsSync } from "node:fs";
import path from "node:path";
import type { Metadata } from "next";
import { Suspense } from "react";
import {
  KunnectLogoIcon,
  KunnectSearchIcon,
  KunnectWordmark,
} from "@/components/brand/kunnect-logo";
import { AiSearchIcon, BellIcon, TagIcon } from "@/components/icons";
import { GuestOnly } from "@/components/layout/guest-only";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "로그인" };

// 이용 방법 3단계(실제 기능 흐름: 글 등록 → AI 매칭 알림 → 소유 확인 후 전달)
const STEPS = [
  { title: "글 등록", description: "잃어버리거나 주운 물건을 사진과 함께 올려요" },
  { title: "AI 매칭", description: "비슷한 분실·습득 글을 찾아 알려 드려요" },
  { title: "안전한 전달", description: "소유 확인 후 직접 만나거나 비대면으로 돌려받아요" },
];

const FEATURES = [
  { title: "AI 매칭", description: "분실물·습득물 AI 자동 매칭", Icon: AiSearchIcon },
  { title: "태그 관리", description: "카테고리·태그로 빠른 검색", Icon: TagIcon },
  { title: "실시간 알림", description: "매칭 시 푸시 알림으로 확인", Icon: BellIcon },
];

// 캠퍼스 사진은 public/images/login-hero.jpg 에 두면 적용된다.
// 파일이 없을 때 url() 레이어를 넣으면 매 방문마다 404 요청이 생기므로, 서버에서 파일이 있을 때만 레이어를 넣는다.
const HERO_IMAGE = "/images/login-hero.jpg";
const hasHeroImage = existsSync(path.join(process.cwd(), "public", HERO_IMAGE));

const PAGE_BACKGROUND = [
  // 흰 베일(globals.css --page-veil): 로그인 후 메인 화면(bg-page-ku)과 같은 정의를 쓴다.
  "var(--page-veil)",
  ...(hasHeroImage ? [`url(${HERO_IMAGE})`] : []),
  // 앱 공통 초록 그라데이션(globals.css --page-gradient-ku)
  "var(--page-gradient-ku)",
].join(", ");

export default function LoginPage() {
  // 이미 로그인한 사용자는 메인으로 보낸다(GuestOnly).
  return (
    <GuestOnly>
      <main
        className="flex min-h-screen w-full break-keep bg-cover bg-center"
        style={{ backgroundImage: PAGE_BACKGROUND }}
      >
        {/* 데스크톱 히어로(lg 이상). 모바일·태블릿에서는 로그인 카드만 보인다. */}
        <section
          aria-label="KUnnect 소개"
          className="hidden flex-1 flex-col justify-between px-12 py-14 lg:flex xl:px-16"
        >
          <div>
            <div className="flex items-center gap-5">
              <KunnectLogoIcon className="size-20 text-brand-600" />
              {/* 히어로 워드마크의 "KU"만 초록(사용자 지정 색 #0f6e3a). 카드 제목·버튼 등은 파란색 유지. */}
              <KunnectWordmark className="text-6xl xl:text-7xl" kuClassName="text-ku-green" />
            </div>
            <p className="mt-10 text-3xl leading-snug font-bold text-slate-900 xl:text-4xl">
              잃어버린 물건, <span className="text-brand-600">KUnnect</span>가 연결해드려요.
            </p>
            <p className="mt-3 text-lg text-slate-600">AI 기반 대학 분실물 통합 매칭 플랫폼</p>
          </div>

          {/* 이용 방법: 머리말과 기능 카드 사이의 빈 공간 가운데에 둔다. */}
          <div className="flex flex-1 items-center py-10">
            <div className="w-full max-w-md rounded-2xl bg-white/85 p-6 shadow-sm backdrop-blur-sm">
              <p id="how-to-heading" className="text-sm font-semibold text-brand-700">
                이용 방법
              </p>
              <ol aria-labelledby="how-to-heading" className="mt-4">
                {STEPS.map(({ title, description }, i) => (
                  <li key={title} className="relative flex gap-4 pb-6 last:pb-0">
                    {/* 단계 사이 연결선(마지막 단계 제외) */}
                    {i < STEPS.length - 1 && (
                      <span
                        aria-hidden="true"
                        className="absolute top-10 bottom-0 left-5 w-px -translate-x-1/2 bg-brand-200"
                      />
                    )}
                    <span
                      aria-hidden="true"
                      className="relative flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-600 text-base font-bold text-white shadow-sm"
                    >
                      {i + 1}
                    </span>
                    <div className="pt-1">
                      <p className="text-base font-bold text-slate-900">{title}</p>
                      <p className="mt-0.5 text-sm text-slate-600">{description}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </div>

          <ul className="grid max-w-2xl grid-cols-3 gap-2">
            {FEATURES.map(({ title, description, Icon }) => (
              <li
                key={title}
                className="flex flex-col items-center rounded-lg bg-white/85 px-3 py-4 text-center shadow-sm backdrop-blur-sm"
              >
                <Icon className="size-9 text-brand-600" />
                <p className="mt-2 text-sm font-bold text-slate-900">{title}</p>
                <p className="mt-1 text-xs leading-relaxed text-slate-600">{description}</p>
              </li>
            ))}
          </ul>
        </section>

        {/* 로그인 카드 */}
        <div className="flex w-full flex-col items-center justify-center px-4 py-8 sm:px-6 lg:w-1/2 lg:max-w-3xl lg:shrink-0 lg:py-10 lg:pr-12 lg:pl-0">
          <div className="w-full max-w-xl rounded-3xl bg-white px-5 py-8 shadow-xl shadow-slate-900/5 sm:px-12 sm:py-12 lg:px-10 xl:px-12">
            <div className="flex flex-col items-center text-center">
              <div className="flex size-24 items-center justify-center rounded-full bg-brand-50 sm:size-32">
                <KunnectSearchIcon className="size-16 text-brand-600 sm:size-24" />
              </div>
              <h1 className="mt-5 flex items-baseline gap-2 text-3xl sm:text-4xl">
                <KunnectWordmark /> <span className="font-bold text-slate-900">로그인</span>
              </h1>
              <p className="mt-3 text-sm text-slate-600 sm:text-base">
                KUnnect 계정으로 로그인하여 서비스를 이용하세요.
              </p>
            </div>

            <div className="mt-8">
              {/* LoginForm 이 useSearchParams 를 쓰므로 Suspense 경계가 필요하다. */}
              <Suspense>
                <LoginForm />
              </Suspense>
            </div>

            <p className="mt-8 text-center text-xs text-slate-500">
              © {new Date().getFullYear()} KUnnect. All rights reserved.
            </p>
          </div>
        </div>
      </main>
    </GuestOnly>
  );
}
