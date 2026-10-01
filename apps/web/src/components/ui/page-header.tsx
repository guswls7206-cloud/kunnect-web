import type { ReactNode } from "react";

interface PageHeaderProps {
  title: ReactNode;
  /** 제목 아래 한 줄 설명(선택) */
  subtitle?: ReactNode;
  /** 제목 오른쪽에 둘 버튼 등(선택). 제목과 위쪽을 맞춘다. */
  actions?: ReactNode;
  /** aria-labelledby 로 h1 을 참조할 때 쓰는 id */
  id?: string;
}

/** 주요 화면 공통 제목: 내용 카드 밖·위에 h1 하나, 왼쪽 정렬, 같은 크기·굵기. */
export function PageHeader({ title, subtitle, actions, id }: PageHeaderProps) {
  const heading = (
    <>
      <h1 id={id} className="text-2xl font-bold text-zinc-900">
        {title}
      </h1>
      {subtitle && <p className="mt-1 text-sm text-zinc-600">{subtitle}</p>}
    </>
  );

  if (!actions) return <header>{heading}</header>;
  return (
    <header className="flex items-start justify-between gap-3">
      <div className="min-w-0">{heading}</div>
      {actions}
    </header>
  );
}
