"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { PostCreateForm } from "@/components/post/post-create-form";
import { Spinner } from "@/components/ui/states";

function NewPost() {
  const type = useSearchParams().get("type") === "FOUND" ? "FOUND" : "LOST";
  // 같은 화면에서 ?type= 만 바뀌어 이동하면(분실 → 습득) 컴포넌트가 재사용되어 폼 기본값이 그대로 남는다.
  // 유형별로 key 를 달리해 새로 마운트하고, 해당 유형의 기본값으로 다시 시작한다.
  return <PostCreateForm key={type} initialType={type} />;
}

export default function NewPostPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <NewPost />
    </Suspense>
  );
}
