import type { PostStatus, PostType } from "@/lib/api/types";

export function TypeBadge({ type }: { type: PostType }) {
  const lost = type === "LOST";
  return (
    <span
      className={`rounded-md px-2 py-0.5 text-xs font-semibold ${lost ? "bg-lost-bg text-lost" : "bg-found-bg text-found"}`}
    >
      {lost ? "분실" : "습득"}
    </span>
  );
}

const STATUS_LABEL: Record<PostStatus, string> = {
  OPEN: "진행 중",
  MATCHED: "매칭됨",
  RETURNED: "반환 완료",
  CLOSED: "종료",
};

/** 상태는 색뿐 아니라 텍스트로도 표시한다(색각 접근성). 진행 중(OPEN)은 표시하지 않는다. */
export function StatusBadge({ status }: { status: PostStatus }) {
  if (status === "OPEN") return null;
  return (
    <span className="rounded-md bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700 ring-1 ring-zinc-200 ring-inset">
      {STATUS_LABEL[status]}
    </span>
  );
}

/** 스크린리더용 " (읽지 않음 N)". 감싸는 링크 이름이 "쪽지 (읽지 않음 1)" 처럼 되도록 라벨 뒤에 둔다. */
export function UnreadSrText({ count }: { count: number }) {
  if (count <= 0) return null;
  // 공백을 별도 텍스트 노드로 두어야 접근성 이름 계산에서 라벨과 붙지 않는다.
  return (
    <>
      {" "}
      <span className="sr-only">(읽지 않음 {count})</span>
    </>
  );
}

/**
 * 읽지 않은 개수 배지. 숫자는 시각용(aria-hidden)이다.
 * srText=false 이면 스크린리더 텍스트를 빼고, 대신 라벨 뒤에 UnreadSrText 를 직접 둔다(배지가 라벨 앞에 있을 때).
 */
const BADGE_PLACEMENT = {
  // 아이콘 오른쪽 위에 겹쳐 띄운다(감싸는 요소가 relative). 왼쪽 끝을 고정해 "99+" 처럼 길어져도 오른쪽으로만 늘어난다.
  overlay:
    "absolute -top-1 left-[calc(100%-0.5rem)] min-w-4 px-1 text-[10px] leading-4 ring-2 ring-white",
  // 글자 바로 뒤에 붙인다. 레이아웃 안에 자리를 차지하므로 옆 메뉴와 겹치지 않는다.
  inline: "ml-1.5 inline-block min-w-5 px-1.5 text-[11px] leading-5",
} as const;

export function CountBadge({
  count,
  srText = true,
  placement = "overlay",
}: {
  count: number;
  srText?: boolean;
  placement?: keyof typeof BADGE_PLACEMENT;
}) {
  if (count <= 0) return null;
  return (
    <>
      <span
        aria-hidden="true"
        className={`rounded-full bg-red-600 text-center font-bold whitespace-nowrap text-white ${BADGE_PLACEMENT[placement]}`}
      >
        {count > 99 ? "99+" : count}
      </span>
      {srText && <UnreadSrText count={count} />}
    </>
  );
}
