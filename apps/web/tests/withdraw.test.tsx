import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WithdrawSection } from "@/components/account/withdraw-section";
import { ToastProvider } from "@/components/ui/toast";
import { api } from "@/lib/api/endpoints";

const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <WithdrawSection />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const openDialog = async () => {
  await userEvent.click(screen.getByRole("button", { name: "탈퇴하기" }));
  return screen.getByRole("dialog", { name: "탈퇴하기" });
};
const passwordInput = () => screen.getByLabelText(/비밀번호 확인/);
const confirmButton = (dialog: HTMLElement) =>
  dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!;

describe("탈퇴하기", () => {
  beforeEach(async () => {
    replace.mockClear();
    await api.auth.login({ loginId: "demo_a", password: "demo1234" });
  });

  it("대화상자를 열면 탈퇴 안내를 보여 주고, 취소하면 닫힌다", async () => {
    renderSection();
    const dialog = await openDialog();
    expect(dialog).toHaveAttribute("open");
    expect(dialog).toHaveTextContent("계정을 되살릴 수 없어요");
    expect(dialog).toHaveTextContent("작성한 글과 댓글은 바로 영구 삭제돼요");
    await userEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(dialog).not.toHaveAttribute("open");
    expect(replace).not.toHaveBeenCalled();
  });

  it("비밀번호를 비우면 요청하지 않고 오류를 보여 준다", async () => {
    renderSection();
    const dialog = await openDialog();
    await userEvent.click(confirmButton(dialog));
    expect(await screen.findByText("비밀번호를 입력해 주세요.")).toBeInTheDocument();
    await expect(api.me.get()).resolves.toMatchObject({ loginId: "demo_a" });
  });

  it("비밀번호가 틀리면 입력칸 아래에 오류를 보여 주고 머문다", async () => {
    renderSection();
    const dialog = await openDialog();
    await userEvent.type(passwordInput(), "wrong-password");
    await userEvent.click(confirmButton(dialog));
    expect(await screen.findByText("비밀번호가 올바르지 않습니다.")).toBeInTheDocument();
    expect(passwordInput()).toHaveAttribute("aria-invalid", "true");
    expect(replace).not.toHaveBeenCalled();
  });

  it("맞는 비밀번호면 탈퇴하고 로그인 화면으로 이동하며, 같은 계정으로 다시 로그인할 수 없다", async () => {
    renderSection();
    const dialog = await openDialog();
    await userEvent.type(passwordInput(), "demo1234");
    await userEvent.click(confirmButton(dialog));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
    expect(await screen.findByText("탈퇴가 완료되었어요.")).toBeInTheDocument();
    await expect(api.me.get()).rejects.toMatchObject({ status: 401 });
    await expect(api.auth.login({ loginId: "demo_a", password: "demo1234" })).rejects.toMatchObject(
      { status: 401 },
    );
  });
});
