"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { ToastProvider } from "@/components/ui/toast";
import { isApiError } from "@/lib/api/client";
import { API_MOCK } from "@/lib/env";

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: false,
        // 4xx(요청 오류)는 재시도해도 같으므로 재시도하지 않는다.
        retry: (count, error) =>
          !(isApiError(error) && error.status >= 400 && error.status < 500) && count < 2,
      },
    },
  });
}

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(makeQueryClient);
  const [ready, setReady] = useState(!API_MOCK);

  useEffect(() => {
    if (API_MOCK) {
      // 목 모드: MSW가 준비될 때까지 화면을 그리지 않는다(첫 요청이 실서버로 새지 않게).
      import("@/mocks/browser").then((m) => m.startMocking()).then(() => setReady(true));
      return;
    }
    // PWA 서비스워커는 운영 빌드의 실서버 모드에서만 등록한다(MSW 서비스워커와 범위 충돌 방지).
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }
  }, []);

  if (!ready) {
    return (
      <div
        className="flex min-h-screen items-center justify-center text-sm text-zinc-500"
        role="status"
      >
        불러오는 중…
      </div>
    );
  }

  return (
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}
