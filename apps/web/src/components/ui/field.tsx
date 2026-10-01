import { useId, type ReactNode } from "react";

interface FieldProps {
  label: string;
  error?: string;
  hint?: string;
  required?: boolean;
  /** 라벨 스타일을 바꿀 때만 지정한다(지정하면 기본 클래스를 대체). */
  labelClassName?: string;
  /** id 를 받아 입력 요소에 연결하는 렌더 함수 */
  children: (props: {
    id: string;
    "aria-describedby": string | undefined;
    "aria-invalid": boolean;
  }) => ReactNode;
}

/** 라벨·도움말·오류 메시지를 입력 요소와 연결한다(aria-describedby). */
export function Field({
  label,
  error,
  hint,
  required,
  labelClassName = "text-sm font-semibold text-zinc-800",
  children,
}: FieldProps) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className={labelClassName}>
        {label}
        {required && (
          <span className="ml-0.5 text-red-700" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": Boolean(error) })}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-xs text-red-700">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-zinc-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

// 로그인 화면과 같은 입력칸. 포커스 시 테두리와 링이 강조색으로 붙는다(링 간격 0).
const inputBase =
  "min-h-12 w-full rounded-lg border border-zinc-300 bg-white text-base text-zinc-900 placeholder:text-zinc-500 focus-visible:border-brand-600 focus-visible:outline-offset-0 aria-[invalid=true]:border-red-600";

export const inputClass = `${inputBase} px-4`;

/** 왼쪽에 아이콘(absolute left-4, size-5)을 겹쳐 놓는 입력칸 */
export const inputIconClass = `${inputBase} pl-11 pr-4`;

/** 왼쪽 아이콘 + 오른쪽 버튼(비밀번호 보기 등)이 있는 입력칸 */
export const inputIconWithActionClass = `${inputBase} pl-11 pr-12`;
