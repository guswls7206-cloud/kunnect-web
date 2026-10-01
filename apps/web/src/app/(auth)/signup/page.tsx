"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { LockIcon, UserIcon, UserOutlineIcon } from "@/components/icons";
import { Field, inputIconClass } from "@/components/ui/field";
import { meKey } from "@/features/auth/use-me";
import { signupSchema, type SignupValues } from "@/features/auth/schemas";
import { isApiError } from "@/lib/api/client";
import { api } from "@/lib/api/endpoints";

// 로그인 화면과 같은 입력칸 왼쪽 아이콘
const iconClass =
  "pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-zinc-500";

export default function SignupPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<SignupValues>({ resolver: zodResolver(signupSchema) });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await api.auth.signup(values);
      // 로그인 화면에는 /me 구독자가 없어 invalidate 만으로는 재조회되지 않으므로, 캐시된 "미로그인(null)"을 제거해 이동 후 새로 조회하게 한다.
      queryClient.removeQueries({ queryKey: meKey });
      router.replace("/");
    } catch (error) {
      if (isApiError(error)) {
        // 서버 오류 코드를 해당 입력 칸에 연결한다.
        if (error.code === "LOGIN_ID_TAKEN") return setError("loginId", { message: error.message });
        if (error.code === "NICKNAME_TAKEN")
          return setError("nickname", { message: error.message });
        if (error.fields) {
          for (const [name, message] of Object.entries(error.fields)) {
            if (name === "loginId" || name === "password" || name === "nickname")
              setError(name, { message });
          }
          return;
        }
        return setFormError(error.message);
      }
      setFormError("가입하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      <Field label="아이디" hint="영소문자·숫자·_ 4~20자" error={errors.loginId?.message} required>
        {(p) => (
          <div className="relative">
            <UserIcon className={iconClass} />
            <input
              {...p}
              {...register("loginId")}
              placeholder="아이디를 입력하세요"
              className={inputIconClass}
              autoComplete="username"
              autoCapitalize="none"
            />
          </div>
        )}
      </Field>
      <Field label="비밀번호" hint="8~64자" error={errors.password?.message} required>
        {(p) => (
          <div className="relative">
            <LockIcon className={iconClass} />
            <input
              {...p}
              {...register("password")}
              type="password"
              placeholder="비밀번호를 입력하세요"
              className={inputIconClass}
              autoComplete="new-password"
            />
          </div>
        )}
      </Field>
      <Field
        label="닉네임"
        hint="2~12자. 서비스에서는 닉네임만 보입니다."
        error={errors.nickname?.message}
        required
      >
        {(p) => (
          <div className="relative">
            <UserOutlineIcon className={iconClass} />
            <input
              {...p}
              {...register("nickname")}
              placeholder="닉네임을 입력하세요"
              className={inputIconClass}
              autoComplete="nickname"
            />
          </div>
        )}
      </Field>
      <p className="rounded-lg bg-brand-50 px-4 py-3 text-xs leading-relaxed text-brand-800">
        이메일을 받지 않으므로 비밀번호를 잊으면 찾을 수 없어요. 꼭 기억해 두세요.
      </p>
      {formError && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {formError}
        </p>
      )}
      <Button type="submit" size="lg" loading={isSubmitting}>
        가입하기
      </Button>
      <p className="rounded-lg bg-zinc-100/80 px-4 py-4 text-center text-sm text-zinc-600">
        이미 계정이 있으신가요?{" "}
        <Link href="/login" className="ml-2 rounded font-semibold text-brand-600 hover:underline">
          로그인
        </Link>
      </p>
    </form>
  );
}
