import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { http } from "msw";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import EditPostPage from "@/app/(main)/posts/[id]/edit/page";
import MatchesPage from "@/app/(main)/posts/[id]/matches/page";
import { ToastProvider } from "@/components/ui/toast";
import { api } from "@/lib/api/endpoints";
import { getDb } from "@/mocks/db";
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

/** 권한 안내는 오류가 아니므로 빨간 알림·다시 시도 없이 제목·설명·"글로 돌아가기"만 보인다. */
function expectNeutralNotice(title: string, message: string, postId: number) {
  expect(screen.getByRole("heading", { level: 1, name: title })).toBeInTheDocument();
  expect(screen.getByText(message)).not.toHaveClass("text-red-700");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "다시 시도" })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "글로 돌아가기" })).toHaveAttribute(
    "href",
    `/posts/${postId}`,
  );
  expect(screen.queryByRole("link", { name: "홈으로" })).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "문제가 발생했어요" })).not.toBeInTheDocument();
}

describe("수정·매칭 화면의 권한 안내", () => {
  beforeEach(async () => {
    await api.auth.login({ loginId: "demo_a", password: "demo1234" });
  });

  it("남의 글 수정은 '수정할 수 없어요'를 중립 톤으로 보여 준다", async () => {
    nav.id = "2"; // 데모B 의 글
    renderPage(<EditPostPage />);
    await screen.findByRole("heading", { name: "수정할 수 없어요" });
    expectNeutralNotice("수정할 수 없어요", "내가 쓴 글만 수정할 수 있어요.", 2);
  });

  it.each(["CLOSED", "RETURNED"] as const)(
    "종료된(%s) 내 글 수정도 중립 톤으로 안내한다",
    async (status) => {
      getDb().posts.find((p) => p.id === 1)!.status = status;
      nav.id = "1";
      renderPage(<EditPostPage />);
      await screen.findByRole("heading", { name: "수정할 수 없어요" });
      expectNeutralNotice("수정할 수 없어요", "종료되었거나 반환이 끝난 글은 수정할 수 없어요.", 1);
    },
  );

  it("내 진행 중인 글은 수정 폼을 보여 준다", async () => {
    nav.id = "1";
    renderPage(<EditPostPage />);
    expect(await screen.findByRole("heading", { name: "글 수정" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "수정할 수 없어요" })).not.toBeInTheDocument();
  });

  it("수정 화면에서 글 조회가 서버 오류(500)면 오류 톤과 다시 시도를 유지한다", async () => {
    server.use(http.get(`${B}/posts/:id`, () => errorResponse(500, "INTERNAL", "서버 오류")));
    nav.id = "1";
    renderPage(<EditPostPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("글을 불러오지 못했습니다.");
    expect(screen.getByRole("heading", { name: "문제가 발생했어요" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeInTheDocument();
  });

  it("남의 글 매칭(403)은 '매칭 결과를 볼 수 없어요'를 중립 톤으로 보여 준다", async () => {
    nav.id = "2";
    renderPage(<MatchesPage />);
    await screen.findByRole("heading", { name: "매칭 결과를 볼 수 없어요" });
    expectNeutralNotice("매칭 결과를 볼 수 없어요", "내가 쓴 글의 매칭 결과만 볼 수 있어요.", 2);
  });

  it("매칭 조회가 서버 오류(500)면 오류 톤과 다시 시도를 유지한다", async () => {
    server.use(
      http.get(`${B}/posts/:id/matches`, () => errorResponse(500, "INTERNAL", "서버 오류")),
    );
    nav.id = "1";
    renderPage(<MatchesPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("매칭 결과를 불러오지 못했습니다.");
    expect(screen.getByRole("heading", { name: "문제가 발생했어요" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeInTheDocument();
  });
});
