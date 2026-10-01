/** 로그인 화면 등에서 쓰는 단색 선 아이콘(장식용, aria-hidden). */
type IconProps = { className?: string };

function Svg({ className = "", children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {children}
    </svg>
  );
}

export function UserIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="8" r="4" fill="currentColor" stroke="none" />
      <path d="M4 20c0-4 3.6-6 8-6s8 2 8 6Z" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function LockIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      <rect x="5" y="10" width="14" height="11" rx="2" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** 선(outline) 자물쇠: 권한이 없어 볼 수 없는 화면 안내용(LockIcon 은 입력칸 안의 채운 아이콘) */
export function LockOutlineIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M8 11V7.5a4 4 0 0 1 8 0V11" />
      <rect x="5" y="11" width="14" height="10" rx="2.5" />
      <path d="M12 15v2" />
    </Svg>
  );
}

export function EyeIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  );
}

export function EyeOffIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.8 3.7M6.6 6.6C3.7 8.4 2 12 2 12s3.5 7 10 7c1.9 0 3.6-.6 5-1.5" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
      <path d="m3 3 18 18" />
    </Svg>
  );
}

export function AiSearchIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="13" cy="10" r="7" />
      <path d="m8 15-5 5" />
      <path d="M10 12.5 11.6 7h.8l1.6 5.5M10.5 11h3M16 7v5.5" strokeWidth="1.5" />
    </Svg>
  );
}

export function PinIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12Z" />
      <circle cx="12" cy="9" r="2.5" />
    </Svg>
  );
}

export function TagIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9Z" />
      <circle cx="8" cy="8" r="1.5" />
    </Svg>
  );
}

export function BellIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M6 9a6 6 0 0 1 12 0c0 6 2 8 2 8H4s2-2 2-8Z" />
      <path d="M10 20a2 2 0 0 0 4 0" />
    </Svg>
  );
}

/** 소셜 로그인 버튼용 브랜드 마크(색 포함) */
export function NaverMark({ className = "" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <rect width="24" height="24" rx="4" fill="#03C75A" />
      <path d="M13.6 12.4 10.2 7.5H7.5v9h2.9v-4.9l3.4 4.9h2.7v-9h-2.9Z" fill="#fff" />
    </svg>
  );
}

export function KakaoMark({ className = "" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <rect width="24" height="24" rx="4" fill="#FEE500" />
      <path
        d="M12 6c-3.9 0-7 2.4-7 5.4 0 1.9 1.3 3.6 3.2 4.6l-.7 2.6c-.1.3.3.5.5.3l3-2c.3 0 .7.1 1 .1 3.9 0 7-2.4 7-5.4S15.9 6 12 6Z"
        fill="#191919"
      />
    </svg>
  );
}

export function GoogleMark({ className = "" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <path
        d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3Z"
        fill="#4285F4"
      />
      <path
        d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22Z"
        fill="#34A853"
      />
      <path
        d="M6.4 14c-.2-.6-.3-1.3-.3-2s.1-1.4.3-2V7.4H3.1a10 10 0 0 0 0 9.2L6.4 14Z"
        fill="#FBBC05"
      />
      <path
        d="M12 6c1.5 0 2.8.5 3.8 1.5l2.9-2.9A10 10 0 0 0 3.1 7.4L6.4 10c.8-2.3 3-4 5.6-4Z"
        fill="#EA4335"
      />
    </svg>
  );
}

export function HomeIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="m3 10.5 9-7 9 7" />
      <path d="M5 9v11h5v-6h4v6h5V9" />
    </Svg>
  );
}

export function PencilIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16Z" />
      <path d="m13.5 6.5 4 4" />
    </Svg>
  );
}

export function ChatIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 5h16v11H9l-5 4Z" />
      <path d="M8 10h8M8 13h5" />
    </Svg>
  );
}

/** 선 형태의 사람 아이콘(하단 메뉴용). UserIcon 은 채워진 형태다. */
export function UserOutlineIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" />
    </Svg>
  );
}

export function SearchIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </Svg>
  );
}

export function TrashIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 7h16" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12" />
      <path d="M10 11v5M14 11v5" />
    </Svg>
  );
}
