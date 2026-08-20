import { Suspense } from "react";
import { LikesBrowser } from "@/components/likes-browser";
import { getStorage } from "@/lib/storage";

export default async function LikesPage() {
  const info = await (await getStorage()).maintenance.engineInfo();
  return (
    <Suspense
      fallback={
        <p className="text-sm text-[var(--muted)]">Loading likes…</p>
      }
    >
      <LikesBrowser
        keywordTech={info.searchTech.keyword}
        vectorTech={info.searchTech.vector}
      />
    </Suspense>
  );
}
