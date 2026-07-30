import { Suspense } from "react";
import { LikesBrowser } from "@/components/likes-browser";

export default function LikesPage() {
  return (
    <Suspense
      fallback={
        <p className="text-sm text-[var(--muted)]">Loading likes…</p>
      }
    >
      <LikesBrowser />
    </Suspense>
  );
}
