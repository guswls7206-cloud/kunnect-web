import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoginForm } from "@/app/(auth)/login/login-form";
import { GuestOnly } from "@/components/layout/guest-only";
import { ToastProvider } from "@/components/ui/toast";
import { api } from "@/lib/api/endpoints";
import { server } from "@/mocks/server";

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => new URLSearchParams("next=/posts/2"),
}));

function renderLoginPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <GuestOnly>
          <LoginForm />
        </GuestOnly>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("GuestOnly", () => {
  beforeEach(() => replace.mockClear());

  it("로그인하지 않았으면 로그인 폼을 보여주고 이동하지 않는다", async () => {
    renderLoginPage();
    expect(await screen.findByRole("button", { name: "로그인" })).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("이미 로그인했으면 폼을 보여주지 않고 메인으로 이동한다", async () => {
    await api.auth.login({ loginId: "demo_a", password: "demo1234" });
    renderLoginPage();
    // 확인 중에는 로딩 표시만 보인다(폼 깜빡임 없음).
    expect(screen.getByRole("status")).toBeInTheDocument();
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(screen.queryByRole("button", { name: "로그인" })).not.toBeInTheDocument();
  });

  it("로그인 상태를 확인하지 못하면(서버 오류) 로그인 폼을 그대로 보여준다", async () => {
    server.use(
      http.get("*/api/v1/me", () =>
        HttpResponse.json({ code: "INTERNAL", message: "오류" }, { status: 500 }),
      ),
    );
    renderLoginPage();
    expect(await screen.findByRole("button", { name: "로그인" })).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("폼에서 로그인에 성공하면 next 경로로만 이동한다(메인 이동과 경합하지 않음)", async () => {
    renderLoginPage();
    await userEvent.type(await screen.findByRole("textbox", { name: "아이디" }), "demo_a");
    await userEvent.type(screen.getByLabelText("비밀번호", { selector: "input" }), "demo1234");
    await userEvent.click(screen.getByRole("button", { name: "로그인" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/posts/2"));
    await new Promise((r) => setTimeout(r, 200));
    expect(replace).toHaveBeenCalledTimes(1);
  });
});
