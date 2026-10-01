import { HttpResponse } from "msw";
import type { Me, PostCardData, PostDetail, PostPhoto } from "@/lib/api/types";
import { getDb, getSessionUserId, type MockPost, type MockUser } from "./db";

export const B = "/api/v1";

/** 목 응답 지연(ms). 로딩 UI 확인용. 테스트에서는 0으로 낮춘다. */
export const mockConfig = { delayMs: 250 };

export function errorResponse(
  status: number,
  code: string,
  message: string,
  fields?: Record<string, string>,
) {
  return HttpResponse.json({ error: { code, message, ...(fields ? { fields } : {}) } }, { status });
}

export function currentUser(): MockUser | null {
  const id = getSessionUserId();
  return getDb().users.find((u) => u.id === id) ?? null;
}

export const unauthenticated = () => errorResponse(401, "UNAUTHENTICATED", "로그인이 필요합니다.");

export function unreadNotifications(userId: number): number {
  return getDb().notifications.filter((n) => n.userId === userId && !n.readAt).length;
}

export function unreadMessages(userId: number): number {
  const db = getDb();
  let count = 0;
  for (const conv of db.conversations) {
    const me = conv.members.find((m) => m.userId === userId);
    if (!me || me.left) continue;
    count += db.messages.filter(
      (m) => m.conversationId === conv.id && m.senderId !== userId && m.id > me.lastReadId,
    ).length;
  }
  return count;
}

export function toMe(user: MockUser): Me {
  return {
    id: user.id,
    loginId: user.loginId,
    nickname: user.nickname,
    settings: user.settings,
    unread: { notifications: unreadNotifications(user.id), messages: unreadMessages(user.id) },
  };
}

export function toCard(post: MockPost): PostCardData {
  const db = getDb();
  const location = db.locations.find((l) => l.id === post.locationId)!;
  const author = db.users.find((u) => u.id === post.authorId)!;
  const firstPhoto = db.photos.find((p) => p.photoId === post.photoIds[0]);
  return {
    id: post.id,
    type: post.type,
    title: post.title,
    status: post.status,
    thumbnailUrl: firstPhoto?.url ?? null,
    locationName: location.floor
      ? `${location.buildingName} ${location.floor}층`
      : location.buildingName,
    locationText: post.locationText,
    occurredAt: post.occurredAt,
    tags: post.tags,
    author: { id: author.id, nickname: author.nickname },
    createdAt: post.createdAt,
  };
}

export function toDetail(post: MockPost, viewerId: number): PostDetail {
  const db = getDb();
  const author = db.users.find((u) => u.id === post.authorId)!;
  const photos: PostPhoto[] = post.photoIds
    .map((id) => db.photos.find((p) => p.photoId === id))
    .filter((p): p is NonNullable<typeof p> => Boolean(p))
    .map(({ photoId, url, width, height }) => ({ photoId, url, width, height }));
  return {
    id: post.id,
    type: post.type,
    title: post.title,
    description: post.description,
    status: post.status,
    matchState: post.matchState,
    occurredAt: post.occurredAt,
    location: db.locations.find((l) => l.id === post.locationId)!,
    locationText: post.locationText,
    lat: post.lat,
    lng: post.lng,
    storagePlace: post.storagePlace,
    hiddenFeatures: post.authorId === viewerId ? post.hiddenFeatures : null,
    photos,
    tags: post.tags,
    author: { id: author.id, nickname: author.nickname },
    commentCount: db.comments.filter((c) => c.postId === post.id && !c.deleted).length,
    isMine: post.authorId === viewerId,
    createdAt: post.createdAt,
  };
}

/** 불투명 커서: 여기서는 단순 오프셋 문자열 */
export function paginate<T>(items: T[], url: URL) {
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 20));
  const offset = Number(url.searchParams.get("cursor")) || 0;
  const slice = items.slice(offset, offset + limit);
  const next = offset + limit;
  return { items: slice, nextCursor: next < items.length ? String(next) : null };
}
