import { Suspense } from "react";
import { SavesBrowser } from "@/components/saves-browser";

export default function SavesPage() {
  return (
    <Suspense
      fallback={
        <p className="text-sm text-[var(--muted)]">Loading saves…</p>
      }
    >
      <SavesBrowser />
    </Suspense>
  );
}
