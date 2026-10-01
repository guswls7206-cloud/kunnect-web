"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useToast } from "@/components/ui/toast";
import { isApiError } from "@/lib/api/client";
import { api } from "@/lib/api/endpoints";

/**
 * 로그아웃. 서버가 로그아웃을 처리했을 때만 캐시를 비우고 로그인 화면으로 이동한다.
 * 이미 세션이 끝난 경우(401)는 로그아웃된 것으로 보고 이동하고, 그 밖의 실패는 알림만 띄우고 화면에 머문다
 * (실패했는데 이동하면 서버 세션이 남은 채 로그아웃된 것처럼 보이기 때문).
 */
export function useLogout() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [loggingOut, setLoggingOut] = useState(false);

  async function logout() {
    setLoggingOut(true);
    try {
      await api.auth.logout();
    } catch (error) {
      if (!isApiError(error, 401)) {
        setLoggingOut(false);
        toast.show(
          isApiError(error)
            ? error.message
            : "로그아웃하지 못했습니다. 잠시 후 다시 시도해 주세요.",
          "error",
        );
        return;
      }
    }
    queryClient.clear();
    router.replace("/login");
  }

  return { logout, loggingOut };
}
