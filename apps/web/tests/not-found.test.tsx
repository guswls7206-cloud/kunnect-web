import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { http } from "msw";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ConversationPage from "@/app/(main)/messages/[id]/page";
import MatchesPage from "@/app/(main)/posts/[id]/matches/page";
import PostDetailPage from "@/app/(main)/posts/[id]/page";
import UserProfilePage from "@/app/(main)/users/[id]/page";
import { ErrorState } from "@/components/ui/states";
import { PageHeader } from "@/components/ui/page-header";
import { ToastProvider } from "@/components/ui/toast";
import { api } from "@/lib/api/endpoints";
import { parsePositiveIntId } from "@/lib/ids";
import { B, errorResponse } from "@/mocks/helpers";
import { server } from "@/mocks/server";

// 페이지가 읽는 경로 파라미터를 테스트마다 바꾼다.
const nav = vi.hoisted(() => ({ id: "1" }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: nav.id }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn() }),
  usePathname: () => "/",
}));

function renderPage(page: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>{page}</ToastProvider>
    </QueryClientProvider>,
  );
}

describe("ErrorState notice", () => {
  it("빨간 오류 알림 없이 제목·설명·홈으로 버튼을 보여 준다", () => {
    const { container } = render(
      <ErrorState
        variant="notice"
        title="게시글을 찾을 수 없어요"
        message="삭제되었거나 주소가 잘못되었어요."
      />,
    );
    expect(
      screen.getByRole("heading", { level: 1, name: "게시글을 찾을 수 없어요" }),
    ).toBeInTheDocument();
    expect(screen.getByText("삭제되었거나 주소가 잘못되었어요.")).not.toHaveClass("text-red-700");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "다시 시도" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "홈으로" })).toHaveAttribute("href", "/");
    // 기본 아이콘은 가방+돋보기(64 viewBox)
    expect(container.querySelector("svg")).toHaveAttribute("viewBox", "0 0 64 64");
  });

  it("action·icon 으로 주요 버튼과 자물쇠 아이콘을 바꿀 수 있다", () => {
    const { container } = render(
      <ErrorState
        variant="notice"
        title="수정할 수 없어요"
        message="내가 쓴 글만 수정할 수 있어요."
        icon="lock"
        action={{ href: "/posts/2", label: "글로 돌아가기" }}
      />,
    );
    expect(screen.getByRole("link", { name: "글로 돌아가기" })).toHaveAttribute("href", "/posts/2");
    expect(screen.queryByRole("link", { name: "홈으로" })).not.toBeInTheDocument();
    expect(container.querySelector("svg")).toHaveAttribute("viewBox", "0 0 24 24");
  });
});

describe("404 와 일반 오류 구분", () => {
  beforeEach(async () => {
    await api.auth.login({ loginId: "demo_a", password: "demo1234" });
  });

  it("없는 글(404)은 '게시글을 찾을 수 없어요'를 중립 톤으로 보여 준다", async () => {
    nav.id = "9999";
    renderPage(<PostDetailPage />);
    expect(
      await screen.findByRole("heading", { name: "게시글을 찾을 수 없어요" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("글 조회가 서버 오류(500)면 오류 톤과 다시 시도를 보여 준다", async () => {
    server.use(http.get(`${B}/posts/:id`, () => errorResponse(500, "INTERNAL", "서버 오류")));
    nav.id = "1";
    renderPage(<PostDetailPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("글을 불러오지 못했습니다.");
    expect(screen.getByRole("heading", { name: "문제가 발생했어요" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeInTheDocument();
  });

  it("없는 사용자(404)는 '사용자를 찾을 수 없어요'를 보여 준다", async () => {
    nav.id = "9999";
    renderPage(<UserProfilePage />);
    expect(
      await screen.findByRole("heading", { name: "사용자를 찾을 수 없어요" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("프로필 조회가 서버 오류(500)면 오류 톤을 유지한다", async () => {
    server.use(http.get(`${B}/users/:id`, () => errorResponse(500, "INTERNAL", "서버 오류")));
    nav.id = "2";
    renderPage(<UserProfilePage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("프로필을 불러오지 못했습니다.");
  });
});

describe("parsePositiveIntId", () => {
  it.each([
    ["1", 1],
    ["42", 42],
    ["abc", null],
    ["1.5", null],
    ["0", null],
    ["-1", null],
    ["01", null],
    ["", null],
    ["99999999999999999999", null],
    [undefined, null],
    [["1"], null],
  ])("%j → %j", (raw, expected) => {
    expect(parsePositiveIntId(raw as string | string[] | undefined)).toBe(expected);
  });
});

describe("올바르지 않은 id·없는 대상", () => {
  beforeEach(async () => {
    await api.auth.login({ loginId: "demo_a", password: "demo1234" });
  });

  it.each(["abc", "1.5", "0", "-3"])(
    "글 상세 id=%s 이면 조회 없이 바로 '게시글을 찾을 수 없어요'",
    (id) => {
      nav.id = id;
      renderPage(<PostDetailPage />);
      // 로딩 없이 첫 렌더에서 바로 보인다(find 가 아닌 get).
      expect(screen.getByRole("heading", { name: "게시글을 찾을 수 없어요" })).toBeInTheDocument();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    },
  );

  it("대화 id=abc 이면 바로 '대화를 찾을 수 없어요'", () => {
    nav.id = "abc";
    renderPage(<ConversationPage />);
    expect(screen.getByRole("heading", { name: "대화를 찾을 수 없어요" })).toBeInTheDocument();
  });

  it("없는 대화(404)는 '대화를 찾을 수 없어요'를 중립 톤으로 보여 준다", async () => {
    nav.id = "9999";
    renderPage(<ConversationPage />);
    expect(
      await screen.findByRole("heading", { name: "대화를 찾을 수 없어요" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("없는 글의 매칭 결과(404)는 '게시글을 찾을 수 없어요'", async () => {
    nav.id = "9999";
    renderPage(<MatchesPage />);
    expect(
      await screen.findByRole("heading", { name: "게시글을 찾을 수 없어요" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("매칭 결과 조회가 서버 오류(500)면 오류 톤을 유지한다", async () => {
    server.use(
      http.get(`${B}/posts/:id/matches`, () => errorResponse(500, "INTERNAL", "서버 오류")),
    );
    nav.id = "1";
    renderPage(<MatchesPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("매칭 결과를 불러오지 못했습니다.");
  });
});

describe("PageHeader", () => {
  it("h1 하나와 부제·액션을 그린다", () => {
    render(<PageHeader id="h" title="알림" subtitle="부제" actions={<button>모두 읽음</button>} />);
    const h1 = screen.getByRole("heading", { level: 1, name: "알림" });
    expect(h1).toHaveAttribute("id", "h");
    expect(h1).toHaveClass("text-2xl", "font-bold");
    expect(screen.getByText("부제")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "모두 읽음" })).toBeInTheDocument();
  });
});
