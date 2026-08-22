import { Suspense } from "react";
import { MediaBrowser } from "@/components/media-browser";
import { getStorage } from "@/lib/storage";

export default async function SavesPage() {
  const info = await (await getStorage()).maintenance.engineInfo();
  return (
    <Suspense
      fallback={
        <p className="text-sm text-[var(--muted)]">Loading saves…</p>
      }
    >
      <MediaBrowser
        library="saves"
        keywordTech={info.searchTech.keyword}
        vectorTech={info.searchTech.vector}
      />
    </Suspense>
  );
}
