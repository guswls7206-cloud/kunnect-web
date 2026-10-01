import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import MessagesPage from "@/app/(main)/messages/page";
import { ToastProvider } from "@/components/ui/toast";
import { api } from "@/lib/api/endpoints";
import { server } from "@/mocks/server";

function renderInbox() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MessagesPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const trash = () => screen.getByRole("button", { name: "대화 삭제" });
// 토스트 안내는 polite/assertive 두 live 영역 중 하나에 나타난다.
const toastText = (text: string) =>
  waitFor(() => {
    const live = [...document.querySelectorAll("[data-toast-live]")]
      .map((el) => el.textContent)
      .join(" ");
    expect(live).toContain(text);
  });

describe("쪽지함 대화 삭제", () => {
  beforeEach(async () => {
    await api.auth.login({ loginId: "demo_a", password: "demo1234" });
  });

  it("각 카드 오른쪽에 삭제 버튼이 있고, 링크 안에 들어 있지 않다", async () => {
    renderInbox();
    await screen.findByText("데모B");
    const button = trash();
    expect(button.closest("a")).toBeNull(); // 유효한 HTML: <a> 안에 <button> 금지
    expect(button).toHaveClass("size-11"); // 44px 터치 영역
    expect(screen.getByRole("link", { name: /데모B/ })).toHaveAttribute("href", "/messages/1");
  });

  it("삭제를 누르면 확인 대화상자가 뜨고, 취소하면 그대로 남는다", async () => {
    renderInbox();
    await screen.findByText("데모B");
    await userEvent.click(trash());
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("이 대화를 삭제할까요?")).toBeInTheDocument();
    expect(dialog).toHaveTextContent("내 쪽지함에서만 삭제되며 상대방에게는 영향이 없습니다.");
    await userEvent.click(within(dialog).getByRole("button", { name: "취소" }));
    expect(screen.getByText("데모B")).toBeInTheDocument();
    expect((await api.conversations.list()).items).toHaveLength(1); // 서버에서도 안 지워짐
  });

  it("확인하면 목록에서 사라지고 빈 상태와 성공 안내를 보여준다", async () => {
    renderInbox();
    await screen.findByText("데모B");
    await userEvent.click(trash());
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "삭제" }),
    );
    expect(await screen.findByText("아직 쪽지가 없어요")).toBeInTheDocument();
    expect(screen.queryByText("데모B")).not.toBeInTheDocument();
    await toastText("대화를 삭제했어요.");
    expect((await api.conversations.list()).items).toHaveLength(0);
  });

  it("진행 중인 인수 요청이 있으면(409) 목록을 되돌리고 오류 안내를 보여준다", async () => {
    await api.handovers.request(1, { postId: 2 });
    renderInbox();
    await screen.findByText("데모B");
    await userEvent.click(trash());
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "삭제" }),
    );
    await toastText("진행 중인 인수 요청이 있어 삭제할 수 없습니다.");
    expect(screen.getByText("데모B")).toBeInTheDocument();
    expect((await api.conversations.list()).items).toHaveLength(1);
  });

  it("이미 삭제된 대화(404)는 목록에서 빼고 안내한다", async () => {
    server.use(
      http.delete("/api/v1/conversations/:id", () =>
        HttpResponse.json(
          { error: { code: "NOT_FOUND", message: "대화를 찾을 수 없습니다." } },
          { status: 404 },
        ),
      ),
    );
    renderInbox();
    await screen.findByText("데모B");
    await userEvent.click(trash());
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "삭제" }),
    );
    expect(await screen.findByText("아직 쪽지가 없어요")).toBeInTheDocument();
    await toastText("이미 삭제된 대화예요.");
  });

  it("네트워크 오류면 되돌리고 일반 오류 안내를 보여준다", async () => {
    server.use(http.delete("/api/v1/conversations/:id", () => HttpResponse.error()));
    renderInbox();
    await screen.findByText("데모B");
    await userEvent.click(trash());
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "삭제" }),
    );
    await toastText("대화를 삭제하지 못했습니다.");
    expect(screen.getByText("데모B")).toBeInTheDocument();
  });

  it("API: 삭제는 멱등(204)이고 상대 쪽지함에는 영향이 없다", async () => {
    await api.conversations.remove(1);
    await api.conversations.remove(1); // 두 번째도 204
    expect((await api.conversations.list()).items).toHaveLength(0);
    await api.auth.login({ loginId: "demo_b", password: "demo1234" });
    expect((await api.conversations.list()).items).toHaveLength(1);
  });
});
