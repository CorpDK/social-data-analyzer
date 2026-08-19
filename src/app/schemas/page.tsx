import { SchemaExplorer } from "@/components/schema-explorer";
import { getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";

export default async function SchemasPage({
  searchParams,
}: {
  searchParams: Promise<{ importId?: string }>;
}) {
  const params = await searchParams;
  const storage = await getStorage();
  const catalog = await storage.catalog.getSchemaCatalog(params.importId ?? "all");

  return (
    <div className="space-y-5">
      <section className="space-y-1.5">
        <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
          Export structure
        </p>
        <h1 className="font-[family-name:var(--font-fraunces)] text-3xl tracking-tight sm:text-4xl">
          Schema explorer
        </h1>
        <p className="max-w-3xl text-sm text-[var(--muted)]">
          Structural schemas for every JSON file found in imported Instagram
          export zips — types, keys, and nesting only. Use this to plan features
          beyond saved posts. Exact message or media payloads are not stored.
        </p>
      </section>

      <SchemaExplorer
        initialMode={catalog.mode}
        initialImportId={catalog.importId}
        imports={catalog.imports.map((row) => ({
          ...row,
          importedAt: row.importedAt.toISOString(),
        }))}
        files={catalog.files}
        emptyReason={catalog.emptyReason}
      />
    </div>
  );
}
