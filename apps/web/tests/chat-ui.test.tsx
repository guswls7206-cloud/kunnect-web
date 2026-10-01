import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ConversationPage from "@/app/(main)/messages/[id]/page";
import { ConversationMenu } from "@/components/message/conversation-menu";
import { ToastProvider } from "@/components/ui/toast";
import { api } from "@/lib/api/endpoints";
import type { ConversationItem } from "@/lib/api/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useParams: () => ({ id: "1" }),
}));

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}

const conversation: ConversationItem = {
  id: 1,
  other: { id: 2, nickname: "데모B" },
  lastMessage: null,
  unread: 0,
  muted: false,
  readOnly: false,
  postContext: null,
  handover: null,
};

describe("대화 메뉴 키보드 조작(WAI-ARIA 메뉴 버튼)", () => {
  it("열면 첫 항목에 포커스, ↑↓·Home·End 로 순환 이동한다", async () => {
    const user = userEvent.setup();
    wrap(<ConversationMenu conversation={conversation} />);
    const trigger = screen.getByRole("button", { name: "대화 메뉴" });

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const items = screen.getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["음소거", "신고", "차단", "나가기"]);
    expect(items[0]).toHaveFocus();
    // 항목은 Tab 순서에서 빠지고(roving), 화살표로만 이동한다.
    items.forEach((i) => expect(i).toHaveAttribute("tabindex", "-1"));

    await user.keyboard("{ArrowDown}");
    expect(items[1]).toHaveFocus();
    await user.keyboard("{End}");
    expect(items[3]).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(items[0]).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(items[3]).toHaveFocus();
    await user.keyboard("{Home}");
    expect(items[0]).toHaveFocus();
  });

  it("Esc 는 메뉴를 닫고 버튼으로 포커스를 돌려준다", async () => {
    const user = userEvent.setup();
    wrap(<ConversationMenu conversation={conversation} />);
    const trigger = screen.getByRole("button", { name: "대화 메뉴" });

    await user.click(trigger);
    await user.keyboard("{ArrowDown}{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });

  it("Tab 은 메뉴를 닫는다", async () => {
    const user = userEvent.setup();
    wrap(<ConversationMenu conversation={conversation} />);
    await user.click(screen.getByRole("button", { name: "대화 메뉴" }));
    await user.tab();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("버튼에서 ↓ 는 첫 항목, ↑ 는 마지막 항목으로 열린다", async () => {
    const user = userEvent.setup();
    wrap(<ConversationMenu conversation={conversation} />);
    const trigger = screen.getByRole("button", { name: "대화 메뉴" });

    trigger.focus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getAllByRole("menuitem").at(-1)).toHaveFocus();
    await user.keyboard("{Escape}");
    await user.keyboard("{ArrowDown}");
    expect(screen.getAllByRole("menuitem")[0]).toHaveFocus();
  });
});

describe("대화 화면 스크롤 기준점", () => {
  const scrolled: Element[] = [];
  const original = Element.prototype.scrollIntoView;

  beforeEach(async () => {
    scrolled.length = 0;
    // jsdom 에는 레이아웃·scrollIntoView 가 없어, 어떤 요소로 스크롤했는지만 기록한다.
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    await api.auth.login({ loginId: "demo_a", password: "demo1234" });
  });
  afterEach(() => {
    Element.prototype.scrollIntoView = original;
  });

  // 회귀 방지: 기준점이 입력창보다 앞에 있으면 sticky 입력창·하단 메뉴가 마지막 말풍선을 덮는다(QA #2).
  it("기준점은 입력창 뒤에 있고, 보낸 뒤 그 기준점으로 스크롤한다", async () => {
    const user = userEvent.setup();
    wrap(<ConversationPage />);
    const input = await screen.findByLabelText("쪽지 입력");
    const end = screen.getByTestId("chat-end");

    const form = input.closest("form")!;
    expect(form.compareDocumentPosition(end) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(end.className).toContain("scroll-mb-");
    await waitFor(() => expect(scrolled).toContain(end));

    scrolled.length = 0;
    await user.type(input, "새 쪽지{Enter}");
    expect(await screen.findByText("새 쪽지")).toBeInTheDocument();
    await waitFor(() => expect(scrolled).toContain(end));
  });
});
