import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommentSection } from "@/components/comment/comment-section";
import { ToastProvider } from "@/components/ui/toast";
import { api } from "@/lib/api/endpoints";
import { notificationHref } from "@/lib/notification-target";
import { maskContacts } from "@/mocks/handlers-social";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

function renderComments(postId: number, closed = false, postAuthorId?: number) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <CommentSection postId={postId} closed={closed} postAuthorId={postAuthorId} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("notificationHref", () => {
  it("알림 종류별로 이동 경로를 만든다", () => {
    expect(notificationHref({ target: { kind: "match", id: 1, postId: 5 } })).toBe(
      "/posts/5/matches",
    );
    expect(notificationHref({ target: { kind: "comment", id: 9, postId: 5 } })).toBe(
      "/posts/5#comment-9",
    );
    expect(notificationHref({ target: { kind: "conversation", id: 3, postId: null } })).toBe(
      "/messages/3",
    );
    expect(notificationHref({ target: { kind: "match", id: 1, postId: null } })).toBe("/");
  });
});

describe("목 서버 규칙(계약 재현)", () => {
  beforeEach(async () => {
    await api.auth.login({ loginId: "demo_a", password: "demo1234" });
  });

  it("연락처는 마스킹되고 시간·층 표기는 그대로 둔다", () => {
    expect(maskContacts("010-1234-5678 로 연락").masked).toBe(true);
    expect(maskContacts("a@b.com").text).not.toContain("@");
    expect(maskContacts("3층 301호, 10:30에 만나요")).toEqual({
      text: "3층 301호, 10:30에 만나요",
      masked: false,
    });
  });

  it("매칭 후보는 등급만 내려가고 점수 필드가 없다", async () => {
    const { items } = await api.matches.forPost(1);
    expect(items.map((m) => m.grade)).toEqual(["HIGH", "MID"]);
    expect(items[0]).not.toHaveProperty("score");
  });

  it("다른 사람 글의 매칭은 403, 확인 후 재결정은 409", async () => {
    await expect(api.matches.forPost(2)).rejects.toMatchObject({ status: 403 });
    await api.matches.confirm(1);
    await expect(api.matches.reject(1)).rejects.toMatchObject({
      status: 409,
      code: "ALREADY_DECIDED",
    });
    expect((await api.posts.get(1)).status).toBe("MATCHED");
  });

  it("알림 읽음 처리가 /me 의 읽지 않음 수에 반영된다", async () => {
    expect((await api.me.get()).unread.notifications).toBe(1);
    const list = await api.notifications.list();
    await api.notifications.read(list.items.find((n) => !n.readAt)!.id);
    expect((await api.me.get()).unread.notifications).toBe(0);
  });

  it("종료된 글에는 댓글을 달 수 없다(409 POST_CLOSED)", async () => {
    await api.posts.setStatus(1, "CLOSED");
    await expect(api.comments.create(1, { body: "hi" })).rejects.toMatchObject({
      status: 409,
      code: "POST_CLOSED",
    });
  });

  it("같은 글에 이중 신고하면 409", async () => {
    await api.reports.create({ targetType: "POST", targetId: 2, reason: "SPAM" });
    await expect(
      api.reports.create({ targetType: "POST", targetId: 2, reason: "SPAM" }),
    ).rejects.toMatchObject({ code: "ALREADY_REPORTED" });
  });
});

describe("CommentSection", () => {
  beforeEach(async () => {
    await api.auth.login({ loginId: "demo_a", password: "demo1234" });
  });

  it("댓글과 답글을 보여주고 내 댓글에만 수정·삭제, 남의 댓글에는 신고를 보여준다", async () => {
    renderComments(2);
    expect(await screen.findByText("혹시 안쪽에 스티커가 붙어 있나요?")).toBeInTheDocument();
    expect(screen.getByText("쪽지로 알려 주세요.")).toBeInTheDocument();
    const mine = screen.getByText("혹시 안쪽에 스티커가 붙어 있나요?").closest("li")!;
    expect(within(mine).getAllByRole("button", { name: "수정" }).length).toBeGreaterThan(0);
    const others = screen.getByText("쪽지로 알려 주세요.").closest("li")!;
    expect(within(others).getByRole("button", { name: "신고" })).toBeInTheDocument();
    expect(within(others).queryByRole("button", { name: "답글" })).toBeNull(); // 대댓글은 1단계만
  });

  it("댓글을 작성하면 목록에 나타나고 연락처는 가려진다", async () => {
    renderComments(2);
    await screen.findByText("쪽지로 알려 주세요.");
    await userEvent.type(screen.getByLabelText("댓글 입력"), "연락주세요 010-1234-5678");
    await userEvent.click(screen.getByRole("button", { name: "등록" }));
    expect(await screen.findByText(/연락주세요 ●+/)).toBeInTheDocument();
    expect(await screen.findByText(/가려졌어요/)).toBeInTheDocument();
  });

  it("글쓴이가 쓴 댓글·답글에만 이름 뒤에 (글쓴이)를 붙여 강조한다", async () => {
    // 시드 2번 글의 글쓴이는 데모B(id 2). 댓글은 데모A, 답글은 데모B.
    renderComments(2, false, 2);
    await screen.findByText("쪽지로 알려 주세요.");
    const reply = screen.getByText("쪽지로 알려 주세요.").closest("li")!;
    const authorName = within(reply).getByText("데모B(글쓴이)");
    expect(authorName).toHaveClass("text-brand-700");
    const comment = screen.getByText("혹시 안쪽에 스티커가 붙어 있나요?").closest("li")!;
    // 댓글 li 안에 답글이 들어 있으므로, 댓글 자신의 이름 줄만 확인한다.
    expect(within(comment).getByText("데모A")).toHaveClass("text-zinc-800");
    expect(screen.getAllByText(/\(글쓴이\)/)).toHaveLength(1);
  });

  it("글쓴이 id 를 모르면 표시하지 않는다", async () => {
    renderComments(2);
    await screen.findByText("쪽지로 알려 주세요.");
    expect(screen.queryByText(/\(글쓴이\)/)).toBeNull();
  });

  it("종료된 글이면 입력이 비활성화된다", async () => {
    renderComments(2, true);
    await screen.findByText("쪽지로 알려 주세요.");
    expect(screen.getByLabelText("댓글 입력")).toBeDisabled();
    await waitFor(() => expect(screen.queryByRole("button", { name: "답글" })).toBeNull());
  });
});
