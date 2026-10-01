import type { NotificationItem } from "./api/types";

/** 알림 종류별 이동 경로(README 9절 6번). postId 가 없으면 홈으로 보낸다. */
export function notificationHref({ target }: Pick<NotificationItem, "target">): string {
  switch (target.kind) {
    case "match":
      return target.postId ? `/posts/${target.postId}/matches` : "/";
    case "comment":
      return target.postId ? `/posts/${target.postId}#comment-${target.id}` : "/";
    case "conversation":
      return `/messages/${target.id}`;
  }
}
