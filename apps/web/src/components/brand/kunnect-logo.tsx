/** KUnnect 로고: 말풍선 안의 가방 아이콘. 장식용이므로 aria-hidden 처리하고, 의미는 옆의 워드마크가 전달한다. */
export function KunnectLogoIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" fill="none" aria-hidden="true" className={className}>
      {/* 말풍선 */}
      <path
        d="M32 5C17.1 5 5 16.6 5 31c0 14.4 12.1 26 27 26 4.3 0 8.4-1 12-2.7L56 59l-2.6-11A25.3 25.3 0 0 0 59 31C59 16.6 46.9 5 32 5Z"
        stroke="currentColor"
        strokeWidth="3.5"
        strokeLinejoin="round"
      />
      <BackpackPaths />
    </svg>
  );
}

/** 로그인 카드 상단의 원형 아이콘: 가방 + 돋보기 + 신호. */
export function KunnectSearchIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" fill="none" aria-hidden="true" className={className}>
      <BackpackPaths />
      <circle cx="44" cy="44" r="7" fill="white" stroke="currentColor" strokeWidth="3" />
      <path d="m49 49 6 6" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" />
      <path
        d="M50 8a8 8 0 0 1 8 8M50 13a3 3 0 0 1 3 3"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function BackpackPaths() {
  return (
    <g stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      {/* 손잡이 */}
      <path d="M26 20v-2a6 6 0 0 1 12 0v2" />
      {/* 몸통 */}
      <rect x="20" y="20" width="24" height="25" rx="6" />
      {/* 앞주머니 */}
      <path d="M24 32h16M24 37h16" />
      <path d="M30 32v2" />
    </g>
  );
}

/**
 * "KU"만 강조색(brand-600)인 워드마크.
 * kuClassName 으로 "KU" 색을 따로 지정할 수 있다(지정하면 기본 색 클래스를 대체).
 */
export function KunnectWordmark({
  className = "",
  kuClassName = "text-brand-600",
}: {
  className?: string;
  kuClassName?: string;
}) {
  return (
    <span className={`font-extrabold tracking-tight ${className}`}>
      <span className={kuClassName}>KU</span>
      <span className="text-slate-900">nnect</span>
    </span>
  );
}
