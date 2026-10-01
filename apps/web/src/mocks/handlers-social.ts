// 댓글·알림·매칭·신고 목 핸들러. 계약: apps/api/openapi.yaml
import { http, HttpResponse, delay } from "msw";
import type { Comment, MatchItem, NotificationItem } from "@/lib/api/types";
import { getDb, type MockComment, type MockMatch } from "./db";
import {
  B,
  currentUser,
  errorResponse,
  mockConfig,
  paginate,
  toCard,
  unauthenticated,
  unreadMessages,
  unreadNotifications,
} from "./helpers";
import { COMMENT_TEXT, REPLY_TEXT } from "./seed";

/** 서버의 연락처 마스킹을 단순 재현: 전화번호·이메일·@아이디를 ●로 치환한다. */
export function maskContacts(body: string): { text: string; masked: boolean } {
  const patterns = [/0\d{1,2}[-\s.]?\d{3,4}[-\s.]?\d{4}/g, /\S+@\S+\.\S+/g, /@[A-Za-z0-9_.]{2,}/g];
  let masked = false;
  let text = body;
  for (const pattern of patterns) {
    text = text.replace(pattern, (m) => {
      masked = true;
      return "●".repeat(m.length);
    });
  }
  return { text, masked };
}

function toComment(c: MockComment, viewerId: number, replies: MockComment[]): Comment {
  const db = getDb();
  const author = db.users.find((u) => u.id === c.authorId)!;
  return {
    id: c.id,
    postId: c.postId,
    parentId: c.parentId,
    author: { id: author.id, nickname: author.nickname },
    body: c.deleted ? null : c.body,
    status: c.deleted ? "DELETED" : "VISIBLE",
    createdAt: c.createdAt,
    editedAt: c.editedAt,
    isMine: c.authorId === viewerId,
    replies: replies.map((r) => toComment(r, viewerId, [])),
  };
}

function notify(userId: number, type: "COMMENT" | "REPLY", comment: MockComment) {
  const db = getDb();
  db.notifications.push({
    id: db.nextIds.notification++,
    userId,
    type,
    text: type === "COMMENT" ? COMMENT_TEXT : REPLY_TEXT,
    createdAt: new Date().toISOString(),
    readAt: null,
    target: { kind: "comment", id: comment.id, postId: comment.postId },
  });
}

function toMatchItem(m: MockMatch, postId: number): MatchItem {
  const db = getDb();
  const otherId = m.lostPostId === postId ? m.foundPostId : m.lostPostId;
  return {
    matchId: m.id,
    level: m.level,
    grade: m.grade,
    locationDiff: m.locationDiff,
    otherPost: toCard(db.posts.find((p) => p.id === otherId)!),
    aiReason: m.aiReason,
    status: m.status,
  };
}

export const socialHandlers = [
  // ───── 댓글 ─────
  http.get(`${B}/posts/:id/comments`, async ({ params, request }) => {
    await delay(mockConfig.delayMs);
    const user = currentUser();
    if (!user) return unauthenticated();
    const postId = Number(params.id);
    const db = getDb();
    if (!db.posts.some((p) => p.id === postId))
      return errorResponse(404, "NOT_FOUND", "글을 찾을 수 없습니다.");
    const all = db.comments.filter((c) => c.postId === postId);
    const tops = all
      .filter((c) => c.parentId === null)
      // 삭제됐고 답글도 없으면 목록에서 사라진다(자리 유지는 답글이 있을 때만).
      .filter((c) => !c.deleted || all.some((r) => r.parentId === c.id && !r.deleted))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const page = paginate(tops, new URL(request.url));
    const items = page.items.map((c) =>
      toComment(
        c,
        user.id,
        all
          .filter((r) => r.parentId === c.id && !r.deleted)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      ),
    );
    return HttpResponse.json({ items, nextCursor: page.nextCursor });
  }),

  http.post(`${B}/posts/:id/comments`, async ({ params, request }) => {
    await delay(mockConfig.delayMs);
    const user = currentUser();
    if (!user) return unauthenticated();
    const db = getDb();
    const post = db.posts.find((p) => p.id === Number(params.id));
    if (!post) return errorResponse(404, "NOT_FOUND", "글을 찾을 수 없습니다.");
    if (post.status === "CLOSED" || post.status === "RETURNED") {
      return errorResponse(409, "POST_CLOSED", "종료된 글에는 댓글을 달 수 없습니다.");
    }
    const body = (await request.json()) as { body?: string; parentId?: number };
    const text = body.body?.trim() ?? "";
    if (!text || text.length > 300) {
      return errorResponse(400, "VALIDATION_ERROR", "댓글은 1~300자로 입력해 주세요.", {
        body: "댓글은 1~300자로 입력해 주세요.",
      });
    }
    const parent = body.parentId ? db.comments.find((c) => c.id === body.parentId) : null;
    if (body.parentId && (!parent || parent.postId !== post.id || parent.parentId !== null)) {
      return errorResponse(400, "PARENT_INVALID", "답글을 달 수 없는 댓글입니다.");
    }
    const { text: safe, masked } = maskContacts(text);
    const comment: MockComment = {
      id: db.nextIds.comment++,
      postId: post.id,
      parentId: parent?.id ?? null,
      authorId: user.id,
      body: safe,
      deleted: false,
      createdAt: new Date().toISOString(),
      editedAt: null,
    };
    db.comments.push(comment);
    // 알림: 답글이면 원 댓글 작성자, 아니면 글 작성자(본인 제외)
    const target = parent ? parent.authorId : post.authorId;
    if (target !== user.id) notify(target, parent ? "REPLY" : "COMMENT", comment);
    return HttpResponse.json({ comment: toComment(comment, user.id, []), masked }, { status: 201 });
  }),

  http.patch(`${B}/comments/:id`, async ({ params, request }) => {
    await delay(mockConfig.delayMs);
    const user = currentUser();
    if (!user) return unauthenticated();
    const comment = getDb().comments.find((c) => c.id === Number(params.id));
    if (!comment) return errorResponse(404, "NOT_FOUND", "댓글을 찾을 수 없습니다.");
    if (comment.authorId !== user.id)
      return errorResponse(403, "FORBIDDEN", "수정 권한이 없습니다.");
    if (comment.deleted) return errorResponse(409, "COMMENT_DELETED", "삭제된 댓글입니다.");
    const body = (await request.json()) as { body?: string };
    const text = body.body?.trim() ?? "";
    if (!text || text.length > 300) {
      return errorResponse(400, "VALIDATION_ERROR", "댓글은 1~300자로 입력해 주세요.", {
        body: "댓글은 1~300자로 입력해 주세요.",
      });
    }
    const { text: safe, masked } = maskContacts(text);
    comment.body = safe;
    comment.editedAt = new Date().toISOString();
    return HttpResponse.json({ comment: toComment(comment, user.id, []), masked });
  }),

  http.delete(`${B}/comments/:id`, async ({ params }) => {
    await delay(mockConfig.delayMs);
    const user = currentUser();
    if (!user) return unauthenticated();
    const db = getDb();
    const comment = db.comments.find((c) => c.id === Number(params.id));
    if (!comment) return errorResponse(404, "NOT_FOUND", "댓글을 찾을 수 없습니다.");
    if (comment.authorId !== user.id)
      return errorResponse(403, "FORBIDDEN", "삭제 권한이 없습니다.");
    comment.deleted = true;
    return new HttpResponse(null, { status: 204 });
  }),

  // ───── 알림 ─────
  http.get(`${B}/notifications`, async ({ request }) => {
    await delay(mockConfig.delayMs);
    const user = currentUser();
    if (!user) return unauthenticated();
    const mine = getDb()
      .notifications.filter((n) => n.userId === user.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const page = paginate(mine, new URL(request.url));
    const items: NotificationItem[] = page.items.map(
      ({ id, type, text, createdAt, readAt, target }) => ({
        id,
        type,
        text,
        createdAt,
        readAt,
        target,
      }),
    );
    return HttpResponse.json({
      items,
      unreadCount: unreadNotifications(user.id),
      nextCursor: page.nextCursor,
    });
  }),

  http.get(`${B}/notifications/unread-count`, async () => {
    const user = currentUser();
    if (!user) return unauthenticated();
    return HttpResponse.json({
      notifications: unreadNotifications(user.id),
      messages: unreadMessages(user.id),
    });
  }),

  http.post(`${B}/notifications/read-all`, async () => {
    const user = currentUser();
    if (!user) return unauthenticated();
    const now = new Date().toISOString();
    getDb()
      .notifications.filter((n) => n.userId === user.id && !n.readAt)
      .forEach((n) => (n.readAt = now));
    return new HttpResponse(null, { status: 204 });
  }),

  http.post(`${B}/notifications/:id/read`, async ({ params }) => {
    const user = currentUser();
    if (!user) return unauthenticated();
    const n = getDb().notifications.find((x) => x.id === Number(params.id) && x.userId === user.id);
    if (!n) return errorResponse(404, "NOT_FOUND", "알림을 찾을 수 없습니다.");
    n.readAt ??= new Date().toISOString();
    return new HttpResponse(null, { status: 204 });
  }),

  // ───── 매칭 ─────
  http.get(`${B}/posts/:id/matches`, async ({ params }) => {
    await delay(mockConfig.delayMs);
    const user = currentUser();
    if (!user) return unauthenticated();
    const db = getDb();
    const post = db.posts.find((p) => p.id === Number(params.id));
    if (!post) return errorResponse(404, "NOT_FOUND", "글을 찾을 수 없습니다.");
    if (post.authorId !== user.id)
      return errorResponse(403, "FORBIDDEN", "내 글의 매칭만 볼 수 있습니다.");
    const items = db.matches
      .filter(
        (m) =>
          (post.type === "LOST" ? m.lostPostId : m.foundPostId) === post.id &&
          m.status !== "REJECTED",
      )
      .sort((a, b) => (a.grade === b.grade ? 0 : a.grade === "HIGH" ? -1 : 1))
      .map((m) => toMatchItem(m, post.id));
    return HttpResponse.json({ matchState: post.matchState, items });
  }),

  ...(["confirm", "reject"] as const).map((action) =>
    http.post(`${B}/matches/:id/${action}`, async ({ params }) => {
      await delay(mockConfig.delayMs);
      const user = currentUser();
      if (!user) return unauthenticated();
      const db = getDb();
      const match = db.matches.find((m) => m.id === Number(params.id));
      if (!match) return errorResponse(404, "NOT_FOUND", "매칭을 찾을 수 없습니다.");
      const lost = db.posts.find((p) => p.id === match.lostPostId)!;
      if (lost.authorId !== user.id)
        return errorResponse(403, "FORBIDDEN", "분실글 작성자만 선택할 수 있습니다.");
      if (match.status !== "PENDING")
        return errorResponse(409, "ALREADY_DECIDED", "이미 선택한 후보입니다.");
      match.status = action === "confirm" ? "CONFIRMED" : "REJECTED";
      if (action === "confirm") lost.status = "MATCHED";
      const item = toMatchItem(match, lost.id);
      return HttpResponse.json(
        action === "confirm"
          ? {
              ...item,
              suggestedConversation: {
                otherUserId: db.posts.find((p) => p.id === match.foundPostId)!.authorId,
                postId: match.foundPostId,
              },
            }
          : item,
      );
    }),
  ),

  // ───── 신고(저장만) ─────
  http.post(`${B}/reports`, async ({ request }) => {
    await delay(mockConfig.delayMs);
    const user = currentUser();
    if (!user) return unauthenticated();
    const body = (await request.json()) as {
      targetType?: string;
      targetId?: number;
      reason?: string;
      detail?: string;
    };
    const reasons = ["SPAM", "HARASSMENT", "PRIVACY", "FAKE", "OTHER"];
    if (!body.targetType || !body.targetId || !reasons.includes(body.reason ?? "")) {
      return errorResponse(400, "VALIDATION_ERROR", "신고 사유를 선택해 주세요.");
    }
    const db = getDb();
    if (
      db.reports.some(
        (r) =>
          r.reporterId === user.id &&
          r.targetType === body.targetType &&
          r.targetId === body.targetId,
      )
    ) {
      return errorResponse(409, "ALREADY_REPORTED", "이미 신고한 대상입니다.");
    }
    db.reports.push({ reporterId: user.id, targetType: body.targetType, targetId: body.targetId });
    return HttpResponse.json({ id: db.reports.length }, { status: 201 });
  }),
];
