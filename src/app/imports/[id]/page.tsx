import Link from "next/link";
import { notFound } from "next/navigation";
import { parseImportLog } from "@/lib/import-log";
import { getImportById } from "@/lib/queries";

export const dynamic = "force-dynamic";

function formatDate(value: Date | null | undefined) {
  if (!value) return "—";
  return value.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export default async function ImportDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isFinite(id) || id <= 0) notFound();

  const row = getImportById(id);
  if (!row) notFound();

  const log = parseImportLog(row.notes);

  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <Link
          href="/import"
          className="text-sm text-[var(--accent)] hover:underline"
        >
          ← Import history
        </Link>
        <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
          Import #{row.id}
        </p>
        <h1 className="font-[family-name:var(--font-fraunces)] text-4xl tracking-tight">
          {row.filename}
        </h1>
        <p className="text-[var(--muted)]">
          Imported {formatDate(row.importedAt)} · status{" "}
          <span className="capitalize text-[var(--ink)]">{row.status}</span>
        </p>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: "Found", value: row.itemsFound },
          { label: "Added", value: row.itemsAdded },
          { label: "Updated", value: row.itemsUpdated },
          { label: "Skipped", value: row.itemsSkipped },
        ].map((card) => (
          <div
            key={card.label}
            className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5"
          >
            <p className="text-xs uppercase tracking-[0.16em] text-[var(--muted)]">
              {card.label}
            </p>
            <p className="mt-3 font-[family-name:var(--font-fraunces)] text-4xl tabular-nums">
              {card.value}
            </p>
          </div>
        ))}
      </section>

      {row.error ? (
        <section className="rounded-2xl border border-[var(--danger)]/40 bg-[var(--surface)] p-5">
          <h2 className="font-[family-name:var(--font-fraunces)] text-xl text-[var(--danger)]">
            Error
          </h2>
          <p className="mt-3 text-sm">{row.error}</p>
        </section>
      ) : null}

      {log ? (
        <>
          <section className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5">
            <h2 className="font-[family-name:var(--font-fraunces)] text-xl">
              Parse summary
            </h2>
            <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-[var(--muted)]">JSON files scanned</dt>
                <dd className="font-[family-name:var(--font-ibm)]">
                  {log.filesScanned}
                </dd>
              </div>
              <div>
                <dt className="text-[var(--muted)]">Saved JSON files parsed</dt>
                <dd className="font-[family-name:var(--font-ibm)]">
                  {log.jsonFilesParsed}
                </dd>
              </div>
              <div>
                <dt className="text-[var(--muted)]">Authors found</dt>
                <dd className="font-[family-name:var(--font-ibm)]">
                  {log.authorsFound}
                </dd>
              </div>
              <div>
                <dt className="text-[var(--muted)]">Items with saved date</dt>
                <dd className="font-[family-name:var(--font-ibm)]">
                  {log.itemsWithSavedAt}
                </dd>
              </div>
            </dl>
          </section>

          <section className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5">
            <h2 className="font-[family-name:var(--font-fraunces)] text-xl">
              Type counts
            </h2>
            <ul className="mt-4 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
              {Object.entries(log.typeCounts).map(([type, total]) => (
                <li
                  key={type}
                  className="flex items-center justify-between rounded-xl border border-[var(--line)]/70 px-3 py-2"
                >
                  <span className="capitalize">{type}</span>
                  <span className="font-[family-name:var(--font-ibm)]">
                    {total}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          {log.savedJsonFiles.length > 0 ? (
            <section className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5">
              <h2 className="font-[family-name:var(--font-fraunces)] text-xl">
                Saved JSON files
              </h2>
              <ul className="mt-4 space-y-1 font-[family-name:var(--font-ibm)] text-xs text-[var(--muted)]">
                {log.savedJsonFiles.map((file) => (
                  <li key={file}>{file}</li>
                ))}
              </ul>
            </section>
          ) : null}

          {log.collectionsFound.length > 0 ? (
            <section className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5">
              <h2 className="font-[family-name:var(--font-fraunces)] text-xl">
                Collections found
              </h2>
              <ul className="mt-4 flex flex-wrap gap-2">
                {log.collectionsFound.map((name) => (
                  <li
                    key={name}
                    className="rounded-full border border-[var(--line)] px-3 py-1 text-sm"
                  >
                    {name}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {log.warnings.length > 0 ? (
            <section className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5">
              <h2 className="font-[family-name:var(--font-fraunces)] text-xl">
                Warnings
              </h2>
              <ul className="mt-4 list-disc space-y-1 pl-5 text-sm text-[var(--muted)]">
                {log.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : row.notes ? (
        <section className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5">
          <h2 className="font-[family-name:var(--font-fraunces)] text-xl">
            Notes
          </h2>
          <p className="mt-3 whitespace-pre-wrap text-sm text-[var(--muted)]">
            {row.notes}
          </p>
        </section>
      ) : null}

      <section className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 text-sm text-[var(--muted)]">
        <p>
          Content hash:{" "}
          <span className="font-[family-name:var(--font-ibm)] text-[var(--ink)]">
            {row.contentHash.slice(0, 16)}…
          </span>
        </p>
      </section>
    </div>
  );
}
