// 쪽지·인수·차단 목 핸들러. 계약: apps/api/openapi.yaml
import { http, HttpResponse, delay } from "msw";
import type { ConversationItem, Handover, Message } from "@/lib/api/types";
import { getDb, type MockConversation, type MockHandover, type MockMessage } from "./db";
import { B, currentUser, errorResponse, mockConfig, paginate, unauthenticated } from "./helpers";

const PAIR_BLOCKED = (a: number, b: number) =>
  getDb().blocks.some(
    (x) => (x.blockerId === a && x.blockedId === b) || (x.blockerId === b && x.blockedId === a),
  );

function toMessage(m: MockMessage): Message {
  return {
    id: m.id,
    conversationId: m.conversationId,
    senderId: m.senderId,
    type: m.type,
    body: m.body,
    postId: m.postId,
    createdAt: m.createdAt,
  };
}

function toHandover(h: MockHandover): Handover {
  return {
    id: h.id,
    conversationId: h.conversationId,
    postId: h.postId,
    matchId: h.matchId,
    status: h.status,
  };
}

function toConversation(conv: MockConversation, viewerId: number): ConversationItem {
  const db = getDb();
  const me = conv.members.find((m) => m.userId === viewerId)!;
  const other = conv.members.find((m) => m.userId !== viewerId)!;
  const otherUser = db.users.find((u) => u.id === other.userId)!;
  const msgs = db.messages.filter((m) => m.conversationId === conv.id);
  const last = msgs[msgs.length - 1];
  const context = conv.postContextId ? db.posts.find((p) => p.id === conv.postContextId) : null;
  const handover = db.handovers.filter((h) => h.conversationId === conv.id).at(-1);
  return {
    id: conv.id,
    other: { id: otherUser.id, nickname: otherUser.nickname },
    lastMessage: last ? { createdAt: last.createdAt, type: last.type } : null,
    unread: msgs.filter((m) => m.senderId !== viewerId && m.id > me.lastReadId).length,
    muted: me.muted,
    // 차단 사실은 드러내지 않고 "읽기 전용"으로만 표현한다.
    readOnly: PAIR_BLOCKED(viewerId, other.userId),
    postContext: context ? { id: context.id, title: context.title } : null,
    handover: handover ? toHandover(handover) : null,
  };
}

function addMessage(
  conv: MockConversation,
  senderId: number,
  body: string,
  type: MockMessage["type"],
  postId: number | null,
): MockMessage {
  const db = getDb();
  const message: MockMessage = {
    id: db.nextIds.message++,
    conversationId: conv.id,
    senderId,
    type,
    body,
    postId,
    createdAt: new Date().toISOString(),
  };
  db.messages.push(message);
  // 상대가 대화를 나갔다면 새 메시지가 오면 다시 쪽지함에 나타난다.
  conv.members.forEach((m) => {
    if (m.userId !== senderId) m.left = false;
  });
  const sender = conv.members.find((m) => m.userId === senderId)!;
  sender.lastReadId = Math.max(sender.lastReadId, message.id);
  return message;
}

function findConversation(id: number, userId: number): MockConversation | null {
  const conv = getDb().conversations.find((c) => c.id === id);
  return conv?.members.some((m) => m.userId === userId) ? conv : null;
}

export const messageHandlers = [
  http.get(`${B}/conversations`, async ({ request }) => {
    await delay(mockConfig.delayMs);
    const user = currentUser();
    if (!user) return unauthenticated();
    const db = getDb();
    const lastAt = (c: MockConversation) =>
      db.messages.filter((m) => m.conversationId === c.id).at(-1)?.createdAt ?? c.createdAt;
    const mine = db.conversations
      .filter((c) => c.members.some((m) => m.userId === user.id && !m.left))
      .sort((a, b) => lastAt(b).localeCompare(lastAt(a)));
    const page = paginate(mine, new URL(request.url));
    return HttpResponse.json({
      items: page.items.map((c) => toConversation(c, user.id)),
      nextCursor: page.nextCursor,
    });
  }),

  http.post(`${B}/conversations`, async ({ request }) => {
    await delay(mockConfig.delayMs);
    const user = currentUser();
    if (!user) return unauthenticated();
    const db = getDb();
    const body = (await request.json()) as {
      targetUserId?: number;
      postId?: number;
      body?: string;
    };
    const text = body.body?.trim() ?? "";
    if (!text || text.length > 1000) {
      return errorResponse(400, "VALIDATION_ERROR", "쪽지는 1~1000자로 입력해 주세요.", {
        body: "쪽지는 1~1000자로 입력해 주세요.",
      });
    }
    const post = body.postId ? db.posts.find((p) => p.id === body.postId) : null;
    if (body.postId && !post) return errorResponse(404, "NOT_FOUND", "글을 찾을 수 없습니다.");
    const targetId = body.targetUserId ?? post?.authorId;
    if (!targetId || !db.users.some((u) => u.id === targetId))
      return errorResponse(404, "NOT_FOUND", "상대를 찾을 수 없습니다.");
    if (targetId === user.id)
      return errorResponse(400, "SELF_MESSAGE", "자기 자신에게는 쪽지를 보낼 수 없습니다.");
    if (PAIR_BLOCKED(user.id, targetId))
      return errorResponse(403, "BLOCKED", "쪽지를 보낼 수 없습니다.");

    let conv = db.conversations.find(
      (c) =>
        c.members.some((m) => m.userId === user.id) && c.members.some((m) => m.userId === targetId),
    );
    const created = !conv;
    if (!conv) {
      conv = {
        id: db.nextIds.conversation++,
        members: [
          { userId: user.id, lastReadId: 0, muted: false, left: false },
          { userId: targetId, lastReadId: 0, muted: false, left: false },
        ],
        postContextId: post?.id ?? null,
        createdAt: new Date().toISOString(),
      };
      db.conversations.push(conv);
    } else {
      conv.members.find((m) => m.userId === user.id)!.left = false;
      if (post) conv.postContextId = post.id;
    }
    const message = addMessage(conv, user.id, text, "TEXT", post?.id ?? null);
    return HttpResponse.json(
      { conversation: toConversation(conv, user.id), message: toMessage(message) },
      { status: created ? 201 : 200 },
    );
  }),

  http.get(`${B}/conversations/:id`, async ({ params }) => {
    const user = currentUser();
    if (!user) return unauthenticated();
    const conv = findConversation(Number(params.id), user.id);
    if (!conv) return errorResponse(404, "NOT_FOUND", "대화를 찾을 수 없습니다.");
    return HttpResponse.json(toConversation(conv, user.id));
  }),

  http.get(`${B}/conversations/:id/messages`, async ({ params, request }) => {
    const user = currentUser();
    if (!user) return unauthenticated();
    const conv = findConversation(Number(params.id), user.id);
    if (!conv) return errorResponse(404, "NOT_FOUND", "대화를 찾을 수 없습니다.");
    const url = new URL(request.url);
    const afterId = url.searchParams.get("afterId");
    const beforeId = url.searchParams.get("beforeId");
    const limit = Math.min(50, Number(url.searchParams.get("limit")) || 30);
    let items = getDb()
      .messages.filter((m) => m.conversationId === conv.id)
      .sort((a, b) => a.id - b.id);
    if (afterId) items = items.filter((m) => m.id > Number(afterId));
    else if (beforeId) items = items.filter((m) => m.id < Number(beforeId)).slice(-limit);
    else items = items.slice(-limit);
    return HttpResponse.json({ items: items.map(toMessage) });
  }),

  http.post(`${B}/conversations/:id/messages`, async ({ params, request }) => {
    await delay(mockConfig.delayMs);
    const user = currentUser();
    if (!user) return unauthenticated();
    const conv = findConversation(Number(params.id), user.id);
    if (!conv) return errorResponse(404, "NOT_FOUND", "대화를 찾을 수 없습니다.");
    const other = conv.members.find((m) => m.userId !== user.id)!;
    if (PAIR_BLOCKED(user.id, other.userId))
      return errorResponse(409, "READ_ONLY", "이 대화에서는 메시지를 보낼 수 없습니다.");
    const body = (await request.json()) as {
      type?: MockMessage["type"];
      body?: string;
      postId?: number;
    };
    const text = body.body?.trim() ?? "";
    if (!text || text.length > 1000) {
      return errorResponse(400, "VALIDATION_ERROR", "쪽지는 1~1000자로 입력해 주세요.", {
        body: "쪽지는 1~1000자로 입력해 주세요.",
      });
    }
    const type =
      body.type === "VERIFY_QUESTION" || body.type === "VERIFY_ANSWER" ? body.type : "TEXT";
    const message = addMessage(conv, user.id, text, type, body.postId ?? null);
    return HttpResponse.json({ message: toMessage(message) }, { status: 201 });
  }),

  http.post(`${B}/conversations/:id/read`, async ({ params, request }) => {
    const user = currentUser();
    if (!user) return unauthenticated();
    const conv = findConversation(Number(params.id), user.id);
    if (!conv) return errorResponse(404, "NOT_FOUND", "대화를 찾을 수 없습니다.");
    const { lastMessageId } = (await request.json()) as { lastMessageId: number };
    const me = conv.members.find((m) => m.userId === user.id)!;
    me.lastReadId = Math.max(me.lastReadId, lastMessageId); // 단조 증가만
    return new HttpResponse(null, { status: 204 });
  }),

  http.patch(`${B}/conversations/:id/settings`, async ({ params, request }) => {
    const user = currentUser();
    if (!user) return unauthenticated();
    const conv = findConversation(Number(params.id), user.id);
    if (!conv) return errorResponse(404, "NOT_FOUND", "대화를 찾을 수 없습니다.");
    const { muted } = (await request.json()) as { muted: boolean };
    conv.members.find((m) => m.userId === user.id)!.muted = muted;
    return new HttpResponse(null, { status: 204 });
  }),

  // 내 쪽지함에서만 삭제(계약 DELETE /conversations/{id}): 204(멱등) / 404(대화 아님) / 409 ACTIVE_HANDOVER.
  // 진행 중인 인수(REQUESTED/VERIFIED)가 있으면 409. 단, 읽기 전용 대화(차단 등)는 인수가 자동 거절되므로 삭제를 허용한다.
  http.delete(`${B}/conversations/:id`, async ({ params }) => {
    await delay(mockConfig.delayMs);
    const user = currentUser();
    if (!user) return unauthenticated();
    const conv = findConversation(Number(params.id), user.id);
    if (!conv) return errorResponse(404, "NOT_FOUND", "대화를 찾을 수 없습니다.");
    const me = conv.members.find((m) => m.userId === user.id)!;
    if (me.left) return new HttpResponse(null, { status: 204 }); // 이미 삭제함: 멱등
    const other = conv.members.find((m) => m.userId !== user.id)!;
    const readOnly = PAIR_BLOCKED(user.id, other.userId);
    const active = getDb().handovers.some(
      (h) => h.conversationId === conv.id && (h.status === "REQUESTED" || h.status === "VERIFIED"),
    );
    if (active && !readOnly) {
      return errorResponse(
        409,
        "ACTIVE_HANDOVER",
        "진행 중인 인수 요청이 있어 삭제할 수 없습니다.",
      );
    }
    me.left = true;
    return new HttpResponse(null, { status: 204 });
  }),

  http.post(`${B}/conversations/:id/leave`, async ({ params }) => {
    const user = currentUser();
    if (!user) return unauthenticated();
    const conv = findConversation(Number(params.id), user.id);
    if (!conv) return errorResponse(404, "NOT_FOUND", "대화를 찾을 수 없습니다.");
    conv.members.find((m) => m.userId === user.id)!.left = true;
    return new HttpResponse(null, { status: 204 });
  }),

  // ───── 인수(Handover) ─────
  http.post(`${B}/conversations/:id/handover`, async ({ params, request }) => {
    await delay(mockConfig.delayMs);
    const user = currentUser();
    if (!user) return unauthenticated();
    const db = getDb();
    const conv = findConversation(Number(params.id), user.id);
    if (!conv) return errorResponse(404, "NOT_FOUND", "대화를 찾을 수 없습니다.");
    const body = (await request.json()) as { postId?: number; matchId?: number };
    if (!body.postId) return errorResponse(400, "VALIDATION_ERROR", "글 정보가 필요합니다.");
    if (
      db.handovers.some(
        (h) =>
          h.conversationId === conv.id && (h.status === "REQUESTED" || h.status === "VERIFIED"),
      )
    ) {
      return errorResponse(409, "ALREADY_REQUESTED", "이미 인수 절차가 진행 중입니다.");
    }
    const handover: MockHandover = {
      id: db.nextIds.handover++,
      conversationId: conv.id,
      postId: body.postId,
      matchId: body.matchId ?? null,
      status: "REQUESTED",
      completedBy: [],
    };
    db.handovers.push(handover);
    addMessage(conv, user.id, "인수 절차를 시작했어요.", "SYSTEM", null);
    return HttpResponse.json(toHandover(handover), { status: 201 });
  }),

  http.post(`${B}/handovers/:id/verify`, async ({ params }) => {
    const user = currentUser();
    if (!user) return unauthenticated();
    const db = getDb();
    const h = db.handovers.find((x) => x.id === Number(params.id));
    if (!h) return errorResponse(404, "NOT_FOUND", "인수 요청을 찾을 수 없습니다.");
    const post = db.posts.find((p) => p.id === h.postId)!;
    // 소유 확인은 습득자만 한다: 습득글이면 작성자, 분실글 맥락이면 그 글 작성자가 아닌 쪽.
    const conv0 = db.conversations.find((c) => c.id === h.conversationId)!;
    const finderId =
      post.type === "FOUND"
        ? post.authorId
        : conv0.members.find((m) => m.userId !== post.authorId)!.userId;
    if (finderId !== user.id)
      return errorResponse(403, "FORBIDDEN", "습득자만 소유 확인을 할 수 있습니다.");
    if (h.status !== "REQUESTED")
      return errorResponse(409, "INVALID_TRANSITION", "확인할 수 없는 상태입니다.");
    h.status = "VERIFIED";
    const conv = db.conversations.find((c) => c.id === h.conversationId)!;
    addMessage(conv, user.id, "소유 확인이 완료되었어요.", "SYSTEM", null);
    return HttpResponse.json(toHandover(h));
  }),

  http.post(`${B}/handovers/:id/complete`, async ({ params }) => {
    const user = currentUser();
    if (!user) return unauthenticated();
    const db = getDb();
    const h = db.handovers.find((x) => x.id === Number(params.id));
    if (!h) return errorResponse(404, "NOT_FOUND", "인수 요청을 찾을 수 없습니다.");
    if (h.status !== "VERIFIED")
      return errorResponse(409, "NOT_VERIFIED", "소유 확인 후에 완료할 수 있습니다.");
    if (!h.completedBy.includes(user.id)) h.completedBy.push(user.id);
    const conv = db.conversations.find((c) => c.id === h.conversationId)!;
    if (conv.members.every((m) => h.completedBy.includes(m.userId))) {
      h.status = "COMPLETED";
      db.posts
        .filter((p) => p.id === h.postId || p.id === conv.postContextId)
        .forEach((p) => (p.status = "RETURNED"));
      addMessage(
        conv,
        user.id,
        "양쪽 모두 인수를 확인했어요. 반환이 완료되었습니다.",
        "SYSTEM",
        null,
      );
    }
    return HttpResponse.json(toHandover(h));
  }),

  http.post(`${B}/handovers/:id/reject`, async ({ params }) => {
    const user = currentUser();
    if (!user) return unauthenticated();
    const db = getDb();
    const h = db.handovers.find((x) => x.id === Number(params.id));
    if (!h) return errorResponse(404, "NOT_FOUND", "인수 요청을 찾을 수 없습니다.");
    if (h.status === "COMPLETED")
      return errorResponse(409, "INVALID_TRANSITION", "이미 완료된 인수입니다.");
    h.status = "REJECTED";
    return HttpResponse.json(toHandover(h));
  }),

  // ───── 차단 ─────
  http.get(`${B}/blocks`, async () => {
    const user = currentUser();
    if (!user) return unauthenticated();
    const db = getDb();
    const items = db.blocks
      .filter((b) => b.blockerId === user.id)
      .map((b) => ({
        userId: b.blockedId,
        nickname: db.users.find((u) => u.id === b.blockedId)!.nickname,
        createdAt: b.createdAt,
      }));
    return HttpResponse.json({ items });
  }),

  http.post(`${B}/blocks`, async ({ request }) => {
    const user = currentUser();
    if (!user) return unauthenticated();
    const { userId } = (await request.json()) as { userId: number };
    if (userId === user.id)
      return errorResponse(400, "SELF_BLOCK", "자기 자신은 차단할 수 없습니다.");
    const db = getDb();
    if (!db.users.some((u) => u.id === userId))
      return errorResponse(404, "NOT_FOUND", "사용자를 찾을 수 없습니다.");
    if (!db.blocks.some((b) => b.blockerId === user.id && b.blockedId === userId)) {
      db.blocks.push({
        blockerId: user.id,
        blockedId: userId,
        createdAt: new Date().toISOString(),
      });
    }
    return new HttpResponse(null, { status: 204 });
  }),

  http.delete(`${B}/blocks/:userId`, async ({ params }) => {
    const user = currentUser();
    if (!user) return unauthenticated();
    const db = getDb();
    db.blocks = db.blocks.filter(
      (b) => !(b.blockerId === user.id && b.blockedId === Number(params.userId)),
    );
    return new HttpResponse(null, { status: 204 });
  }),

  // ───── 설정 ─────
  http.patch(`${B}/me/settings`, async ({ request }) => {
    const user = currentUser();
    if (!user) return unauthenticated();
    const patch = (await request.json()) as Partial<typeof user.settings>;
    user.settings = { ...user.settings, ...patch };
    return HttpResponse.json(user.settings);
  }),

  http.post(`${B}/me/password`, async ({ request }) => {
    await delay(mockConfig.delayMs);
    const user = currentUser();
    if (!user) return unauthenticated();
    const { currentPassword, newPassword } = (await request.json()) as {
      currentPassword: string;
      newPassword: string;
    };
    if (currentPassword !== user.password)
      return errorResponse(403, "WRONG_PASSWORD", "현재 비밀번호가 올바르지 않습니다.");
    if (!newPassword || newPassword.length < 8 || newPassword.length > 64) {
      return errorResponse(400, "WEAK_PASSWORD", "새 비밀번호는 8~64자여야 합니다.", {
        newPassword: "새 비밀번호는 8~64자여야 합니다.",
      });
    }
    user.password = newPassword;
    return new HttpResponse(null, { status: 204 });
  }),
];
