import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "danger" | "dangerSecondary" | "ghost";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-brand-600 text-white shadow-sm hover:bg-brand-700 disabled:bg-zinc-200 disabled:text-zinc-500 disabled:shadow-none",
  secondary:
    "border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50 disabled:text-zinc-400",
  // 되돌릴 수 없는 동작으로 들어가는 버튼(설정의 탈퇴하기): 코랄 바탕(사용자 지정 #fc5453)에 흰 글자,
  // hover 는 확인 대화상자의 danger 버튼과 같은 진한 빨강. 주의: 기본 상태 흰 글자 대비 3.2:1(AA 미달, 사용자 결정)
  dangerSecondary:
    "bg-[#fc5453] text-white shadow-sm hover:bg-red-700 disabled:bg-zinc-200 disabled:text-zinc-500 disabled:shadow-none",
  danger:
    "bg-red-700 text-white shadow-sm hover:bg-red-800 disabled:bg-zinc-200 disabled:text-zinc-500 disabled:shadow-none",
  ghost: "text-brand-700 hover:bg-brand-50 disabled:text-zinc-400",
};

type Size = "md" | "lg";

/** md: 일반(44px), lg: 로그인·가입 같은 주요 제출 버튼(48px) */
const SIZES: Record<Size, string> = {
  md: "min-h-11 px-4 text-sm",
  lg: "min-h-12 px-5 text-base",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

/** 터치 타깃 44px 이상(min-h-11) */
export function Button({
  variant = "primary",
  size = "md",
  loading,
  disabled,
  className = "",
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      // transition-colors 는 outline-color 까지 전환해 포커스 링이 흰색에서 서서히 바뀌므로 배경·테두리·글자색만 전환한다.
      className={`inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-[background-color,border-color,color] disabled:cursor-not-allowed ${SIZES[size]} ${VARIANTS[variant]} ${className}`}
      {...rest}
    >
      {loading ? "처리 중…" : children}
    </button>
  );
}

/** 링크를 버튼처럼 보이게 할 때 쓰는 클래스 */
export const linkButtonClass =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white shadow-sm transition-[background-color] hover:bg-brand-700";

/** 링크를 보조(secondary) 버튼처럼 보이게 할 때 쓰는 클래스 */
export const secondaryLinkClass =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-zinc-300 bg-white px-4 text-sm font-semibold text-zinc-700 transition-[background-color,border-color,color] hover:bg-zinc-50";
