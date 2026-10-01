import type { Metadata } from "next";
import { Suspense } from "react";
import { Spinner } from "@/components/ui/states";
import { Feed } from "./feed";

export const metadata: Metadata = { title: "홈" };

export default function HomePage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Feed />
    </Suspense>
  );
}
