import { IndexesStatusPanel } from "@/components/indexes-status-panel";

export const dynamic = "force-dynamic";

export default function IndexesPage() {
  return (
    <div className="space-y-5">
      <section className="space-y-1.5">
        <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
          Semantic search
        </p>
        <h1 className="font-[family-name:var(--font-fraunces)] text-3xl tracking-tight sm:text-4xl">
          Indexes
        </h1>
        <p className="max-w-3xl text-sm text-[var(--muted)]">
          Coverage and health for every embedding provider. After enabling a
          provider in Settings, run Reindex here to build its vector table.
        </p>
      </section>

      <IndexesStatusPanel />
    </div>
  );
}
