import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/ui/toast";
import { useLogout } from "@/features/auth/use-logout";
import { api } from "@/lib/api/endpoints";
import { server } from "@/mocks/server";

const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));

function LogoutButton() {
  const { logout, loggingOut } = useLogout();
  return (
    <button type="button" onClick={logout} disabled={loggingOut}>
      로그아웃
    </button>
  );
}

function renderButton() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <LogoutButton />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const logoutFails = (status: number) =>
  server.use(
    http.post("*/api/v1/auth/logout", () =>
      HttpResponse.json({ error: { code: "X", message: "서버 오류입니다." } }, { status }),
    ),
  );

describe("useLogout", () => {
  beforeEach(() => replace.mockClear());

  it("성공하면 로그인 화면으로 이동한다", async () => {
    await api.auth.login({ loginId: "demo_a", password: "demo1234" });
    renderButton();
    await userEvent.click(screen.getByRole("button", { name: "로그아웃" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
  });

  it("서버 오류면 알림을 띄우고 화면에 머문다", async () => {
    logoutFails(500);
    renderButton();
    await userEvent.click(screen.getByRole("button", { name: "로그아웃" }));
    expect(await screen.findByText("서버 오류입니다.")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "로그아웃" })).toBeEnabled();
  });

  it("이미 세션이 끝났으면(401) 로그아웃된 것으로 보고 이동한다", async () => {
    logoutFails(401);
    renderButton();
    await userEvent.click(screen.getByRole("button", { name: "로그아웃" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
  });
});
