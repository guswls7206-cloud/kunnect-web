import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PostDetailPage from "@/app/(main)/posts/[id]/page";
import MePage from "@/app/(main)/me/page";
import { ToastProvider } from "@/components/ui/toast";
import { api } from "@/lib/api/endpoints";
import { server } from "@/mocks/server";

const replace = vi.fn();
let currentId = "1";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  useParams: () => ({ id: currentId }),
  usePathname: () => "/me",
  useSearchParams: () => new URLSearchParams(),
}));

function renderWith(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}

const toastText = (text: string) =>
  waitFor(() => {
    const live = [...document.querySelectorAll("[data-toast-live]")]
      .map((el) => el.textContent)
      .join(" ");
    expect(live).toContain(text);
  });

const MY_TITLE = "검은색 에어팟 케이스를 잃어버렸어요"; // demo_a 의 글 #1

describe("내 정보 > 내가 쓴 글 삭제", () => {
  beforeEach(async () => {
    replace.mockClear();
    currentId = "1";
    await api.auth.login({ loginId: "demo_a", password: "demo1234" });
  });

  it("각 카드 오른쪽에 삭제 버튼이 있고 링크 안에 들어 있지 않다", async () => {
    renderWith(<MePage />);
    await screen.findByText(MY_TITLE);
    const buttons = screen.getAllByRole("button", { name: "글 삭제" });
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) {
      expect(b.closest("a")).toBeNull();
      expect(b).toHaveClass("size-11");
    }
    expect(screen.getByRole("link", { name: new RegExp(MY_TITLE) })).toHaveAttribute(
      "href",
      "/posts/1",
    );
  });

  it("삭제를 누르면 확인 대화상자가 뜨고 취소하면 그대로 남는다", async () => {
    renderWith(<MePage />);
    await screen.findByText(MY_TITLE);
    await userEvent.click(screen.getAllByRole("button", { name: "글 삭제" })[0]);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("이 글을 삭제할까요?")).toBeInTheDocument();
    expect(dialog).toHaveTextContent("삭제한 글과 댓글·매칭은 복구할 수 없습니다.");
    await userEvent.click(within(dialog).getByRole("button", { name: "취소" }));
    expect(screen.getByText(MY_TITLE)).toBeInTheDocument();
    expect((await api.posts.get(1)).id).toBe(1); // 서버에서도 안 지워짐
  });

  it("확인하면 목록에서 사라지고 서버에서도 영구 삭제된다", async () => {
    renderWith(<MePage />);
    await screen.findByText(MY_TITLE);
    const card = screen.getByText(MY_TITLE).closest("li")!;
    await userEvent.click(within(card).getByRole("button", { name: "글 삭제" }));
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "삭제" }),
    );
    await waitFor(() => expect(screen.queryByText(MY_TITLE)).not.toBeInTheDocument());
    await toastText("글을 삭제했어요.");
    await expect(api.posts.get(1)).rejects.toMatchObject({ status: 404 });
    expect((await api.me.posts()).items.some((p) => p.id === 1)).toBe(false);
  });

  it("진행 중인 인수 요청이 있으면(409) 되돌리고 오류 안내를 보여준다", async () => {
    await api.handovers.request(1, { postId: 1 });
    renderWith(<MePage />);
    await screen.findByText(MY_TITLE);
    const card = screen.getByText(MY_TITLE).closest("li")!;
    await userEvent.click(within(card).getByRole("button", { name: "글 삭제" }));
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "삭제" }),
    );
    await toastText("진행 중인 인수 요청이 있어 삭제할 수 없습니다.");
    expect(screen.getByText(MY_TITLE)).toBeInTheDocument();
    expect((await api.posts.get(1)).id).toBe(1);
  });

  it("이미 삭제된 글(404)은 목록에서 빼고 중립 안내를 보여준다", async () => {
    server.use(
      http.delete("/api/v1/posts/:id", () =>
        HttpResponse.json(
          { error: { code: "NOT_FOUND", message: "글을 찾을 수 없습니다." } },
          { status: 404 },
        ),
      ),
    );
    renderWith(<MePage />);
    await screen.findByText(MY_TITLE);
    const card = screen.getByText(MY_TITLE).closest("li")!;
    await userEvent.click(within(card).getByRole("button", { name: "글 삭제" }));
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "삭제" }),
    );
    await waitFor(() => expect(screen.queryByText(MY_TITLE)).not.toBeInTheDocument());
    await toastText("이미 삭제된 글이에요.");
  });

  it("네트워크 오류면 되돌리고 일반 오류 안내를 보여준다", async () => {
    server.use(http.delete("/api/v1/posts/:id", () => HttpResponse.error()));
    renderWith(<MePage />);
    await screen.findByText(MY_TITLE);
    const card = screen.getByText(MY_TITLE).closest("li")!;
    await userEvent.click(within(card).getByRole("button", { name: "글 삭제" }));
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "삭제" }),
    );
    await toastText("글을 삭제하지 못했습니다.");
    expect(screen.getByText(MY_TITLE)).toBeInTheDocument();
  });
});

describe("글 상세 삭제", () => {
  beforeEach(async () => {
    replace.mockClear();
    currentId = "1";
    await api.auth.login({ loginId: "demo_a", password: "demo1234" });
  });

  it("네이티브 confirm 대신 확인 대화상자를 쓰고, 확인하면 삭제 후 내 정보로 이동한다", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    renderWith(<PostDetailPage />);
    await screen.findByRole("heading", { name: MY_TITLE });
    await userEvent.click(screen.getByRole("button", { name: "삭제" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("이 글을 삭제할까요?")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "삭제" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/me"));
    expect(confirmSpy).not.toHaveBeenCalled();
    await expect(api.posts.get(1)).rejects.toMatchObject({ status: 404 });
    confirmSpy.mockRestore();
  });

  it("종료는 확인 후 CLOSED 로만 바뀌고 글은 남는다(삭제와 다름)", async () => {
    renderWith(<PostDetailPage />);
    await screen.findByRole("heading", { name: MY_TITLE });
    await userEvent.click(screen.getByRole("button", { name: "종료" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "종료" }));
    await toastText("글을 종료했어요.");
    expect((await api.posts.get(1)).status).toBe("CLOSED");
    expect(replace).not.toHaveBeenCalled();
  });

  it("API: 영구 삭제 후 다시 삭제하면 404, 남의 글은 403", async () => {
    await api.posts.remove(1);
    await expect(api.posts.remove(1)).rejects.toMatchObject({ status: 404 });
    await expect(api.posts.remove(2)).rejects.toMatchObject({ status: 403 }); // demo_b 의 글
  });
});
