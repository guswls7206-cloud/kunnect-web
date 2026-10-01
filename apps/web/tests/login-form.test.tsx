import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoginForm, SAVED_LOGIN_ID_KEY } from "@/app/(auth)/login/login-form";
import { ToastProvider } from "@/components/ui/toast";

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => new URLSearchParams("next=/posts/2"),
}));

function renderForm() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <LoginForm />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

// "아이디 저장" 체크박스·"비밀번호 보기" 버튼도 같은 단어를 포함하므로 입력칸을 정확히 지정한다.
const idInput = () => screen.getByRole("textbox", { name: "아이디" });
const passwordInput = () => screen.getByLabelText("비밀번호", { selector: "input" });

describe("LoginForm", () => {
  beforeEach(() => {
    localStorage.clear();
    replace.mockClear();
  });

  it("빈 입력이면 필드 오류를 보여주고 요청하지 않는다", async () => {
    renderForm();
    await userEvent.click(screen.getByRole("button", { name: "로그인" }));
    expect(await screen.findByText("아이디를 입력해 주세요.")).toBeInTheDocument();
    expect(screen.getByText("비밀번호를 입력해 주세요.")).toBeInTheDocument();
  });

  it("틀린 비밀번호면 서버 메시지를 알림으로 보여준다", async () => {
    renderForm();
    await userEvent.type(idInput(), "demo_a");
    await userEvent.type(passwordInput(), "wrong-password");
    await userEvent.click(screen.getByRole("button", { name: "로그인" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "아이디 또는 비밀번호가 올바르지 않습니다.",
    );
  });

  it("성공하면 next 경로로 이동한다", async () => {
    renderForm();
    await userEvent.type(idInput(), "demo_a");
    await userEvent.type(passwordInput(), "demo1234");
    await userEvent.click(screen.getByRole("button", { name: "로그인" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/posts/2"));
  });

  it("비밀번호 보기 버튼으로 입력 내용을 보이거나 숨긴다", async () => {
    renderForm();
    const toggle = screen.getByRole("button", { name: "비밀번호 보기" });
    expect(passwordInput()).toHaveAttribute("type", "password");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(toggle);
    expect(passwordInput()).toHaveAttribute("type", "text");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(toggle);
    expect(passwordInput()).toHaveAttribute("type", "password");
  });

  it("아이디 저장을 선택하고 로그인하면 아이디를 저장하고 다음 방문에 채운다", async () => {
    renderForm();
    await userEvent.type(idInput(), "demo_a");
    await userEvent.type(passwordInput(), "demo1234");
    await userEvent.click(screen.getByRole("checkbox", { name: "아이디 저장" }));
    await userEvent.click(screen.getByRole("button", { name: "로그인" }));
    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(localStorage.getItem(SAVED_LOGIN_ID_KEY)).toBe("demo_a");

    cleanup();
    renderForm();
    await waitFor(() => expect(idInput()).toHaveValue("demo_a"));
    expect(screen.getByRole("checkbox", { name: "아이디 저장" })).toBeChecked();
  });

  it("아이디 저장을 해제하고 로그인하면 저장된 아이디를 지운다", async () => {
    localStorage.setItem(SAVED_LOGIN_ID_KEY, "demo_a");
    renderForm();
    await waitFor(() => expect(idInput()).toHaveValue("demo_a"));
    await userEvent.click(screen.getByRole("checkbox", { name: "아이디 저장" }));
    await userEvent.type(passwordInput(), "demo1234");
    await userEvent.click(screen.getByRole("button", { name: "로그인" }));
    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(localStorage.getItem(SAVED_LOGIN_ID_KEY)).toBeNull();
  });

  it("다시 입력하면 이전 로그인 실패 메시지를 지운다", async () => {
    renderForm();
    await userEvent.type(idInput(), "demo_a");
    await userEvent.type(passwordInput(), "wrong-password");
    await userEvent.click(screen.getByRole("button", { name: "로그인" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await userEvent.type(passwordInput(), "x");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("localStorage 를 읽을 수 없어도 화면이 정상 동작한다", async () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    try {
      renderForm();
      expect(idInput()).toHaveValue("");
      expect(screen.getByRole("checkbox", { name: "아이디 저장" })).not.toBeChecked();
      await userEvent.type(idInput(), "demo_a");
      await userEvent.type(passwordInput(), "demo1234");
      await userEvent.click(screen.getByRole("button", { name: "로그인" }));
      await waitFor(() => expect(replace).toHaveBeenCalledWith("/posts/2"));
    } finally {
      getItem.mockRestore();
    }
  });

  it("아이디를 저장할 수 없어도 로그인은 완료된다", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    try {
      renderForm();
      await userEvent.type(idInput(), "demo_a");
      await userEvent.type(passwordInput(), "demo1234");
      await userEvent.click(screen.getByRole("checkbox", { name: "아이디 저장" }));
      await userEvent.click(screen.getByRole("button", { name: "로그인" }));
      await waitFor(() => expect(replace).toHaveBeenCalledWith("/posts/2"));
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    } finally {
      setItem.mockRestore();
    }
  });

  it.each(["네이버 로그인", "카카오 로그인", "구글 로그인", "비밀번호 찾기"])(
    "%s 버튼은 준비 중 안내를 보여준다",
    async (name) => {
      renderForm();
      await userEvent.click(screen.getByRole("button", { name }));
      expect(await screen.findByText("준비 중인 기능이에요.")).toBeInTheDocument();
      expect(replace).not.toHaveBeenCalled();
    },
  );
});
