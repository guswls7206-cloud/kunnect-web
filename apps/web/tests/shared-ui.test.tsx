import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { inSection, NAV } from "@/components/layout/app-shell";
import { CountBadge } from "@/components/ui/badge";
import { ErrorState } from "@/components/ui/states";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/",
}));

const activeLabels = (pathname: string) => NAV.filter((n) => n.match(pathname)).map((n) => n.label);

describe("메뉴 활성 판정", () => {
  it("경로 경계를 지켜 /messages 가 내 정보로 잡히지 않는다", () => {
    expect(inSection("/messages", "/me")).toBe(false);
    expect(inSection("/me", "/me")).toBe(true);
    expect(inSection("/me/posts", "/me")).toBe(true);
  });

  it.each([
    ["/", ["홈"]],
    ["/messages", ["쪽지"]],
    ["/messages/3", ["쪽지"]],
    ["/me", ["내 정보"]],
    ["/settings", ["내 정보"]],
    ["/notifications", ["알림"]],
    ["/posts/new", ["글쓰기"]],
    ["/posts/4", []],
  ])("%s → %j", (pathname, expected) => {
    expect(activeLabels(pathname)).toEqual(expected);
  });
});

describe("ErrorState", () => {
  it("page: h1 제목·메시지·홈으로 링크를 보여 준다", () => {
    render(<ErrorState message="글을 찾을 수 없어요." />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent("글을 찾을 수 없어요.");
    expect(screen.getByRole("link", { name: "홈으로" })).toHaveAttribute("href", "/");
  });

  it("section: 제목·홈으로 없이 메시지와 다시 시도만 보여 준다", () => {
    const retry = vi.fn();
    render(<ErrorState variant="section" message="목록을 불러오지 못했습니다." onRetry={retry} />);
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "홈으로" })).not.toBeInTheDocument();
    screen.getByRole("button", { name: "다시 시도" }).click();
    expect(retry).toHaveBeenCalled();
  });
});

describe("CountBadge", () => {
  it("감싼 요소 이름에 '(읽지 않음 N)' 이 붙고 숫자는 시각용으로만 쓴다", () => {
    render(
      <button type="button">
        쪽지
        <CountBadge count={1} />
      </button>,
    );
    expect(screen.getByRole("button")).toHaveAccessibleName("쪽지 (읽지 않음 1)");
  });

  it("0 이면 아무것도 그리지 않는다", () => {
    const { container } = render(<CountBadge count={0} />);
    expect(container).toBeEmptyDOMElement();
  });
});
