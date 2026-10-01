import { apiFetch } from "./client";
import type {
  BlockItem,
  Comment,
  ConversationItem,
  ConversationStart,
  Handover,
  CreatePostInput,
  Location,
  MatchItem,
  MatchState,
  MeSettings,
  Message,
  MessageType,
  NotificationItem,
  Me,
  Page,
  PostCardData,
  PostDetail,
  PostListQuery,
  ReportReason,
  ReportTargetType,
  Tag,
  UnreadCount,
  UpdatePostInput,
  UploadedPhoto,
  UserSummary,
} from "./types";

/** 엔드포인트별 타입 함수 모음. 화면은 fetch 를 직접 부르지 않고 이 객체만 쓴다. */
export const api = {
  auth: {
    signup: (input: { loginId: string; password: string; nickname: string }) =>
      apiFetch<{ user: Me }>("/auth/signup", { method: "POST", body: input }),
    login: (input: { loginId: string; password: string }) =>
      apiFetch<{ user: Me }>("/auth/login", { method: "POST", body: input }),
    logout: () => apiFetch<void>("/auth/logout", { method: "POST" }),
  },
  me: {
    get: () => apiFetch<Me>("/me"),
    /** 탈퇴. 비밀번호가 틀리면 403 WRONG_PASSWORD. 성공 시 204(세션 쿠키 제거) */
    withdraw: (password: string) => apiFetch<void>("/me", { method: "DELETE", body: { password } }),
    posts: (query: { type?: string; status?: string; cursor?: string | null } = {}) =>
      apiFetch<Page<PostCardData>>("/me/posts", { query }),
  },
  meta: {
    locations: () => apiFetch<{ items: Location[] }>("/locations"),
    presetTags: () => apiFetch<{ items: Tag[] }>("/tags", { query: { preset: true } }),
    suggestTags: (q: string) => apiFetch<{ items: Tag[] }>("/tags/suggest", { query: { q } }),
  },
  posts: {
    list: (query: PostListQuery & { cursor?: string | null }) =>
      apiFetch<Page<PostCardData>>("/posts", { query: { limit: 20, ...query } }),
    get: (id: number) => apiFetch<PostDetail>(`/posts/${id}`),
    create: (input: CreatePostInput) =>
      apiFetch<PostDetail>("/posts", { method: "POST", body: input }),
    update: (id: number, input: UpdatePostInput) =>
      apiFetch<PostDetail>(`/posts/${id}`, { method: "PATCH", body: input }),
    setStatus: (id: number, status: "CLOSED") =>
      apiFetch<PostDetail>(`/posts/${id}/status`, { method: "POST", body: { status } }),
    remove: (id: number) => apiFetch<void>(`/posts/${id}`, { method: "DELETE" }),
  },
  photos: {
    upload: (file: Blob, filename: string) => {
      const formData = new FormData();
      formData.append("file", file, filename);
      return apiFetch<UploadedPhoto>("/photos", { method: "POST", formData });
    },
    remove: (id: number) => apiFetch<void>(`/photos/${id}`, { method: "DELETE" }),
  },
  users: {
    get: (id: number) =>
      apiFetch<UserSummary & { createdAt: string; postCount: number; isBlockedByMe: boolean }>(
        `/users/${id}`,
      ),
    posts: (id: number, cursor?: string | null) =>
      apiFetch<Page<PostCardData>>(`/users/${id}/posts`, { query: { cursor } }),
  },
  notifications: {
    unreadCount: () => apiFetch<UnreadCount>("/notifications/unread-count"),
    list: (cursor?: string | null) =>
      apiFetch<Page<NotificationItem> & { unreadCount: number }>("/notifications", {
        query: { cursor },
      }),
    read: (id: number) => apiFetch<void>(`/notifications/${id}/read`, { method: "POST" }),
    readAll: () => apiFetch<void>("/notifications/read-all", { method: "POST" }),
  },
  comments: {
    list: (postId: number, cursor?: string | null) =>
      apiFetch<Page<Comment>>(`/posts/${postId}/comments`, { query: { cursor } }),
    create: (postId: number, input: { body: string; parentId?: number }) =>
      apiFetch<{ comment: Comment; masked: boolean }>(`/posts/${postId}/comments`, {
        method: "POST",
        body: input,
      }),
    update: (id: number, body: string) =>
      apiFetch<{ comment: Comment; masked: boolean }>(`/comments/${id}`, {
        method: "PATCH",
        body: { body },
      }),
    remove: (id: number) => apiFetch<void>(`/comments/${id}`, { method: "DELETE" }),
  },
  matches: {
    forPost: (postId: number) =>
      apiFetch<{ matchState: MatchState; items: MatchItem[] }>(`/posts/${postId}/matches`),
    confirm: (id: number) =>
      apiFetch<MatchItem & { suggestedConversation?: { otherUserId: number; postId: number } }>(
        `/matches/${id}/confirm`,
        {
          method: "POST",
        },
      ),
    reject: (id: number) => apiFetch<MatchItem>(`/matches/${id}/reject`, { method: "POST" }),
  },
  conversations: {
    list: (cursor?: string | null) =>
      apiFetch<Page<ConversationItem>>("/conversations", { query: { cursor } }),
    get: (id: number) => apiFetch<ConversationItem>(`/conversations/${id}`),
    start: (input: { targetUserId?: number; postId?: number; body: string }) =>
      apiFetch<ConversationStart>("/conversations", { method: "POST", body: input }),
    messages: (id: number, query: { afterId?: number; beforeId?: number; limit?: number } = {}) =>
      apiFetch<{ items: Message[] }>(`/conversations/${id}/messages`, { query }),
    send: (
      id: number,
      input: { type?: Exclude<MessageType, "SYSTEM">; body: string; postId?: number },
    ) =>
      apiFetch<{ message: Message }>(`/conversations/${id}/messages`, {
        method: "POST",
        body: input,
      }),
    markRead: (id: number, lastMessageId: number) =>
      apiFetch<void>(`/conversations/${id}/read`, { method: "POST", body: { lastMessageId } }),
    setMuted: (id: number, muted: boolean) =>
      apiFetch<void>(`/conversations/${id}/settings`, { method: "PATCH", body: { muted } }),
    leave: (id: number) => apiFetch<void>(`/conversations/${id}/leave`, { method: "POST" }),
    /** 내 쪽지함에서 대화 삭제(상대에게는 영향 없음). 계약: DELETE /conversations/{id} → 204 */
    remove: (id: number) => apiFetch<void>(`/conversations/${id}`, { method: "DELETE" }),
  },
  handovers: {
    request: (conversationId: number, input: { postId: number; matchId?: number }) =>
      apiFetch<Handover>(`/conversations/${conversationId}/handover`, {
        method: "POST",
        body: input,
      }),
    verify: (id: number, note?: string) =>
      apiFetch<Handover>(`/handovers/${id}/verify`, { method: "POST", body: { note } }),
    complete: (id: number) => apiFetch<Handover>(`/handovers/${id}/complete`, { method: "POST" }),
    reject: (id: number) => apiFetch<Handover>(`/handovers/${id}/reject`, { method: "POST" }),
  },
  blocks: {
    list: () => apiFetch<{ items: BlockItem[] }>("/blocks"),
    add: (userId: number) => apiFetch<void>("/blocks", { method: "POST", body: { userId } }),
    remove: (userId: number) => apiFetch<void>(`/blocks/${userId}`, { method: "DELETE" }),
  },
  settings: {
    update: (input: Partial<MeSettings>) =>
      apiFetch<MeSettings>("/me/settings", { method: "PATCH", body: input }),
    changePassword: (input: { currentPassword: string; newPassword: string }) =>
      apiFetch<void>("/me/password", { method: "POST", body: input }),
  },
  reports: {
    create: (input: {
      targetType: ReportTargetType;
      targetId: number;
      reason: ReportReason;
      detail?: string;
    }) => apiFetch<{ id: number }>("/reports", { method: "POST", body: input }),
  },
};
