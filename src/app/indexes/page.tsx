import Link from "next/link";
import { IndexesStatusPanel } from "@/components/indexes-status-panel";

export const dynamic = "force-dynamic";

export default function IndexesPage() {
  return (
    <div className="space-y-5">
      <section className="space-y-1.5">
        <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
          Semantic search
        </p>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="font-[family-name:var(--font-fraunces)] text-3xl tracking-tight sm:text-4xl">
            Indexes
          </h1>
          <Link
            href="/indexes/history"
            className="rounded-full border border-[var(--line)] px-3.5 py-1.5 text-xs font-medium text-[var(--muted)] transition hover:border-[var(--muted)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            History
          </Link>
        </div>
        <p className="max-w-3xl text-sm text-[var(--muted)]">
          Coverage and health for Saves and Likes embedding indexes. After
          enabling a provider in Settings, run Reindex here to build its vector
          table. Reindex all configured rebuilds both libraries.
        </p>
      </section>

      <IndexesStatusPanel />
    </div>
  );
}
