import { beforeEach, describe, expect, it } from "vitest";
import { mergeMessages } from "@/features/messages/queries";
import { api } from "@/lib/api/endpoints";
import { setSessionUserId } from "@/mocks/db";
import type { Message } from "@/lib/api/types";

const msg = (id: number): Message => ({
  id,
  conversationId: 1,
  senderId: 1,
  type: "TEXT",
  body: `m${id}`,
  postId: null,
  createdAt: "2026-10-01T00:00:00Z",
});

describe("mergeMessages", () => {
  it("중복을 제거하고 id 순으로 정렬한다", () => {
    expect(mergeMessages([msg(1), msg(3)], [msg(2), msg(3)]).map((m) => m.id)).toEqual([1, 2, 3]);
  });
  it("새 메시지가 없으면 이전 배열 참조를 그대로 돌려준다(불필요한 렌더 방지)", () => {
    const prev = [msg(1), msg(2)];
    expect(mergeMessages(prev, [])).toBe(prev);
    expect(mergeMessages(prev, [msg(2)])).toBe(prev);
  });
});

describe("쪽지 목 서버 규칙(계약 재현)", () => {
  beforeEach(async () => {
    await api.auth.login({ loginId: "demo_a", password: "demo1234" });
  });
  const asUser = (id: number) => setSessionUserId(id);

  it("읽지 않음 수가 쪽지함·배지에 반영되고 읽음 처리로 줄어든다", async () => {
    expect((await api.notifications.unreadCount()).messages).toBe(1); // demo_b 의 마지막 메시지
    const inbox = await api.conversations.list();
    expect(inbox.items[0].unread).toBe(1);
    await api.conversations.markRead(1, 4);
    expect((await api.notifications.unreadCount()).messages).toBe(0);
  });

  it("읽음 처리는 단조 증가만 허용한다", async () => {
    await api.conversations.markRead(1, 4);
    await api.conversations.markRead(1, 1); // 더 작은 값은 무시
    expect((await api.conversations.get(1)).unread).toBe(0);
  });

  it("폴링: afterId 이후 메시지만 받는다", async () => {
    const { items } = await api.conversations.messages(1, { afterId: 3 });
    expect(items.map((m) => m.id)).toEqual([4]);
    expect((await api.conversations.messages(1, { afterId: 4 })).items).toEqual([]);
  });

  it("같은 상대에게 다시 보내면 기존 대화를 재사용하고, 자기 자신은 거부한다", async () => {
    const start = await api.conversations.start({ postId: 2, body: "다시 연락드려요" });
    expect(start.conversation.id).toBe(1);
    await expect(api.conversations.start({ targetUserId: 1, body: "나" })).rejects.toMatchObject({
      code: "SELF_MESSAGE",
    });
  });

  it("차단하면 양쪽 모두 전송이 막히고 읽기 전용이 되며 사실이 드러나지 않는다", async () => {
    await api.blocks.add(2);
    expect((await api.conversations.get(1)).readOnly).toBe(true);
    const error = await api.conversations.send(1, { body: "hi" }).catch((e) => e);
    expect(error).toMatchObject({ status: 409, code: "READ_ONLY" });
    expect(error.message).not.toMatch(/차단/);
    asUser(2); // 차단당한 쪽
    expect((await api.conversations.get(1)).readOnly).toBe(true);
    await expect(api.conversations.start({ targetUserId: 1, body: "hi" })).rejects.toMatchObject({
      status: 403,
      code: "BLOCKED",
    });
    asUser(1);
    await api.blocks.remove(2);
    expect((await api.conversations.get(1)).readOnly).toBe(false);
  });

  it("인수 흐름: 시작 → 소유 확인(습득자만) → 양측 완료 → 글 RETURNED", async () => {
    const h = await api.handovers.request(1, { postId: 2 });
    expect(h.status).toBe("REQUESTED");
    await expect(api.handovers.request(1, { postId: 2 })).rejects.toMatchObject({
      code: "ALREADY_REQUESTED",
    });
    await expect(api.handovers.verify(h.id)).rejects.toMatchObject({ status: 403 }); // demo_a 는 분실자
    await expect(api.handovers.complete(h.id)).rejects.toMatchObject({ code: "NOT_VERIFIED" });
    asUser(2);
    expect((await api.handovers.verify(h.id)).status).toBe("VERIFIED");
    expect((await api.handovers.complete(h.id)).status).toBe("VERIFIED"); // 한쪽만 확인
    asUser(1);
    expect((await api.handovers.complete(h.id)).status).toBe("COMPLETED");
    expect((await api.posts.get(2)).status).toBe("RETURNED");
    expect((await api.conversations.get(1)).handover?.status).toBe("COMPLETED");
  });

  it("비밀번호 변경: 현재 비밀번호가 틀리면 403, 성공하면 새 비밀번호로 로그인", async () => {
    await expect(
      api.settings.changePassword({ currentPassword: "nope", newPassword: "newpass123" }),
    ).rejects.toMatchObject({ code: "WRONG_PASSWORD" });
    await api.settings.changePassword({ currentPassword: "demo1234", newPassword: "newpass123" });
    await expect(api.auth.login({ loginId: "demo_a", password: "demo1234" })).rejects.toMatchObject(
      { status: 401 },
    );
    await api.auth.login({ loginId: "demo_a", password: "newpass123" });
  });

  it("매칭 확인 응답에 쪽지 시작 정보가 포함된다", async () => {
    const confirmed = await api.matches.confirm(1);
    expect(confirmed.suggestedConversation).toEqual({ otherUserId: 2, postId: 2 });
    expect(confirmed.locationDiff).toBe("SAME_BUILDING");
  });
});

describe("폴링 커서", () => {
  it("내가 보낸 메시지 id 가 더 커도 그 사이 도착한 상대 메시지를 놓치지 않는다", async () => {
    await api.auth.login({ loginId: "demo_a", password: "demo1234" });
    const server = await api.conversations.messages(1, { afterId: 4 });
    expect(server.items).toEqual([]);
    // 상대 메시지(5)가 먼저 저장되고, 내 메시지(6)가 뒤에 저장된 상황
    setSessionUserId(2);
    await api.conversations.send(1, { body: "상대 5" });
    setSessionUserId(1);
    await api.conversations.send(1, { body: "내 6" });
    // 커서가 4(서버 기준)이면 둘 다 받는다. 6 을 커서로 삼았다면 5 를 놓쳤을 것이다.
    expect((await api.conversations.messages(1, { afterId: 4 })).items.map((m) => m.id)).toEqual([
      5, 6,
    ]);
  });
});
