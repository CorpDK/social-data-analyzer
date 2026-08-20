import { Suspense } from "react";
import { SavesBrowser } from "@/components/saves-browser";
import { getStorage } from "@/lib/storage";

export default async function SavesPage() {
  const info = await (await getStorage()).maintenance.engineInfo();
  return (
    <Suspense
      fallback={
        <p className="text-sm text-[var(--muted)]">Loading saves…</p>
      }
    >
      <SavesBrowser
        keywordTech={info.searchTech.keyword}
        vectorTech={info.searchTech.vector}
      />
    </Suspense>
  );
}
