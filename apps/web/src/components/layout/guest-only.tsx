"use client";

import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { Spinner } from "@/components/ui/states";
import { useMe } from "@/features/auth/use-me";

/**
 * 로그인하지 않은 사용자 전용 영역(로그인·회원가입). AppShell 과 반대로, 이미 로그인했으면 메인으로 보낸다.
 * 확인이 끝날 때까지는 로딩 표시를 보여 로그인 폼이 잠깐 보였다 사라지는 일을 막는다.
 * 서버 오류로 확인하지 못하면 로그인을 막지 않도록 그대로 화면을 보여준다.
 */
export function GuestOnly({ children }: { children: ReactNode }) {
  const { data: me, isPending, isFetching, isError } = useMe();
  const router = useRouter();

  useEffect(() => {
    // 재조회 중인 낡은 값으로 잘못 이동하지 않도록 조회가 끝난 뒤에만 이동한다.
    // replace 를 써서 뒤로 가기로 로그인 화면에 돌아와 다시 튕기는 일이 없게 한다.
    if (me && !isFetching) router.replace("/");
  }, [me, isFetching, router]);

  if (isError) return children;

  if (isPending || me) {
    return (
      <div className="flex min-h-screen w-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return children;
}
