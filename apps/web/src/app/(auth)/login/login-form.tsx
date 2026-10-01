"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Field, inputIconClass, inputIconWithActionClass } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import {
  EyeIcon,
  EyeOffIcon,
  GoogleMark,
  KakaoMark,
  LockIcon,
  NaverMark,
  UserIcon,
} from "@/components/icons";
import { meKey } from "@/features/auth/use-me";
import {
  loginFormSchema as formSchema,
  type LoginFormValues as FormValues,
} from "@/features/auth/schemas";
import { isApiError } from "@/lib/api/client";
import { api } from "@/lib/api/endpoints";

/** 로그인 후 돌아갈 경로. 외부 주소로 보내지 않도록 같은 사이트 경로만 허용한다. */
export function safeNextPath(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

/** "아이디 저장" 값을 보관하는 localStorage 키 */
export const SAVED_LOGIN_ID_KEY = "kunnect.savedLoginId";

// 사생활 보호 모드 등에서는 localStorage 접근이 예외를 던질 수 있어 항상 감싼다.
function readSavedLoginId(): string | null {
  try {
    return window.localStorage.getItem(SAVED_LOGIN_ID_KEY);
  } catch {
    return null;
  }
}

function writeSavedLoginId(loginId: string | null) {
  try {
    if (loginId) window.localStorage.setItem(SAVED_LOGIN_ID_KEY, loginId);
    else window.localStorage.removeItem(SAVED_LOGIN_ID_KEY);
  } catch {
    // 저장 실패는 로그인 자체에 영향이 없으므로 무시한다.
  }
}

export function LoginForm() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const toast = useToast();
  const next = safeNextPath(useSearchParams().get("next"));
  const [formError, setFormError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { loginId: "", password: "", rememberId: false },
  });

  // 저장된 아이디는 브라우저에서만 읽을 수 있으므로 마운트 후 채운다(서버 렌더와 불일치 방지).
  useEffect(() => {
    const saved = readSavedLoginId();
    if (saved) {
      setValue("loginId", saved);
      setValue("rememberId", true);
    }
  }, [setValue]);

  const onSubmit = handleSubmit(async ({ loginId, password, rememberId }) => {
    setFormError(null);
    try {
      await api.auth.login({ loginId, password });
      writeSavedLoginId(rememberId ? loginId : null);
      // 로그인 화면에는 /me 구독자가 없어 invalidate 만으로는 재조회되지 않으므로, 캐시된 "미로그인(null)"을 제거해 이동 후 새로 조회하게 한다.
      queryClient.removeQueries({ queryKey: meKey });
      router.replace(next);
    } catch (error) {
      setFormError(
        isApiError(error) ? error.message : "로그인하지 못했습니다. 잠시 후 다시 시도해 주세요.",
      );
    }
  });

  const comingSoon = () => toast.show("준비 중인 기능이에요.");
  // 다시 입력하기 시작하면 이전 로그인 실패 메시지는 더 이상 맞지 않으므로 지운다.
  const clearFormError = () => setFormError(null);

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
        <Field label="아이디" error={errors.loginId?.message}>
          {(p) => (
            <div className="relative">
              <UserIcon className="pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-slate-500" />
              <input
                {...p}
                {...register("loginId", { onChange: clearFormError })}
                aria-required="true"
                placeholder="아이디를 입력하세요"
                className={inputIconClass}
                autoComplete="username"
                autoCapitalize="none"
              />
            </div>
          )}
        </Field>
        <Field label="비밀번호" error={errors.password?.message}>
          {(p) => (
            <div className="relative">
              <LockIcon className="pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-slate-500" />
              <input
                {...p}
                {...register("password", { onChange: clearFormError })}
                aria-required="true"
                type={showPassword ? "text" : "password"}
                placeholder="비밀번호를 입력하세요"
                className={inputIconWithActionClass}
                autoComplete="current-password"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-pressed={showPassword}
                aria-label="비밀번호 보기"
                className="absolute top-1/2 right-2 flex size-9 -translate-y-1/2 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-700"
              >
                {showPassword ? <EyeIcon className="size-5" /> : <EyeOffIcon className="size-5" />}
              </button>
            </div>
          )}
        </Field>

        <div className="-mt-1 flex items-center justify-between">
          <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              {...register("rememberId")}
              className="size-4 rounded border-slate-300 accent-brand-600"
            />
            아이디 저장
          </label>
          <button
            type="button"
            onClick={comingSoon}
            className="min-h-11 rounded px-1 text-sm font-medium text-brand-600 hover:underline"
          >
            비밀번호 찾기
          </button>
        </div>

        {formError && (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {formError}
          </p>
        )}

        <Button type="submit" size="lg" loading={isSubmitting}>
          로그인
        </Button>
      </form>

      <div className="flex items-center gap-3 text-sm text-slate-500">
        <span className="h-px flex-1 bg-slate-200" />
        또는 다른 방법으로 로그인
        <span className="h-px flex-1 bg-slate-200" />
      </div>

      {/* 카드 폭이 좁은 lg 구간(1024~1279px)에서는 라벨이 줄바꿈되지 않도록 세로로 쌓는다. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
        {[
          { label: "네이버 로그인", Mark: NaverMark },
          { label: "카카오 로그인", Mark: KakaoMark },
          { label: "구글 로그인", Mark: GoogleMark },
        ].map(({ label, Mark }) => (
          <button
            key={label}
            type="button"
            onClick={comingSoon}
            className="flex min-h-12 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium whitespace-nowrap text-slate-700 hover:bg-slate-50"
          >
            <Mark className="size-6 shrink-0" />
            {label}
          </button>
        ))}
      </div>

      <p className="rounded-lg bg-slate-100/80 px-4 py-4 text-center text-sm text-slate-600">
        계정이 없으신가요?{" "}
        <Link href="/signup" className="ml-2 rounded font-semibold text-brand-600 hover:underline">
          회원가입
        </Link>
      </p>
    </div>
  );
}
