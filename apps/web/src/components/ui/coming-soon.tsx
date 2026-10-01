import { EmptyState } from "./states";

/** 아직 구현되지 않은 화면의 자리표시. 라우트가 404가 되지 않게 한다. */
export function ComingSoon({ title }: { title: string }) {
  return (
    <section aria-labelledby="coming-soon-title">
      <h1 id="coming-soon-title" className="text-xl font-bold">
        {title}
      </h1>
      <div className="mt-4">
        <EmptyState title="준비 중인 기능이에요" description="곧 만나볼 수 있어요." />
      </div>
    </section>
  );
}
