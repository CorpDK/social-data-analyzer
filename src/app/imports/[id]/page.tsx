import Link from "next/link";
import { notFound } from "next/navigation";
import { DiscardImportRowsButton } from "@/components/discard-import-rows-button";
import {
  parseImportLog,
  resolveAuthorMetrics,
  resolveLikesWriteMetrics,
} from "@/lib/import-log";
import { getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";

function formatDate(value: Date | null | undefined) {
  if (!value) return "—";
  return value.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function MetricCards({
  title,
  cards,
}: {
  title: string;
  cards: Array<{ label: string; value: number }>;
}) {
  return (
    <section className="space-y-3">
      <h2 className="font-[family-name:var(--font-fraunces)] text-xl">{title}</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((card) => (
          <div
            key={`${title}-${card.label}`}
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
      </div>
    </section>
  );
}

function TypeCountsSection({
  title,
  counts,
}: {
  title: string;
  counts: Record<string, number>;
}) {
  const entries = Object.entries(counts);
  if (entries.length === 0) return null;
  return (
    <section className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5">
      <h2 className="font-[family-name:var(--font-fraunces)] text-xl">{title}</h2>
      <ul className="mt-4 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
        {entries.map(([type, total]) => (
          <li
            key={`${title}-${type}`}
            className="flex items-center justify-between rounded-xl border border-[var(--line)]/70 px-3 py-2"
          >
            <span className="capitalize">{type}</span>
            <span className="font-[family-name:var(--font-ibm)]">{total}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function FileListSection({ title, files }: { title: string; files: string[] }) {
  if (files.length === 0) return null;
  return (
    <section className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5">
      <h2 className="font-[family-name:var(--font-fraunces)] text-xl">{title}</h2>
      <ul className="mt-4 space-y-1 font-[family-name:var(--font-ibm)] text-xs text-[var(--muted)]">
        {files.map((file) => (
          <li key={file}>{file}</li>
        ))}
      </ul>
    </section>
  );
}

export default async function ImportDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isFinite(id) || id <= 0) notFound();

  const storage = await getStorage();
  const row = await storage.catalog.getImportById(id);
  if (!row) notFound();

  const log = parseImportLog(row.notes);
  const likesWrite = log ? resolveLikesWriteMetrics(log) : null;
  const authors = log ? resolveAuthorMetrics(log) : null;
  const hasLikes =
    log != null &&
    (log.likesParsed > 0 ||
      log.likedJsonFiles.length > 0 ||
      (likesWrite != null &&
        likesWrite.added + likesWrite.updated + likesWrite.skipped > 0));

  const persisted = await storage.catalog.countPersistedImportRows(id);
  const hasInserts =
    persisted.itemsAdded > 0 || persisted.likesAdded > 0;
  const showDiscard =
    row.status === "failed" ||
    (hasInserts && row.status !== "completed" && row.status !== "duplicate");

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

      <MetricCards
        title="Saves"
        cards={[
          { label: "Found", value: row.itemsFound },
          { label: "Added", value: row.itemsAdded },
          { label: "Updated", value: row.itemsUpdated },
          { label: "Skipped", value: row.itemsSkipped },
        ]}
      />

      {hasLikes && likesWrite ? (
        <MetricCards
          title="Likes"
          cards={[
            { label: "Found", value: log!.likesParsed },
            { label: "Added", value: likesWrite.added },
            { label: "Updated", value: likesWrite.updated },
            { label: "Skipped", value: likesWrite.skipped },
          ]}
        />
      ) : null}

      {row.error ? (
        <section className="rounded-2xl border border-[var(--danger)]/40 bg-[var(--surface)] p-5">
          <h2 className="font-[family-name:var(--font-fraunces)] text-xl text-[var(--danger)]">
            Error
          </h2>
          <p className="mt-3 text-sm">{row.error}</p>
          {showDiscard || hasInserts ? (
            <div className="mt-4">
              <DiscardImportRowsButton importId={id} />
            </div>
          ) : null}
        </section>
      ) : hasInserts && row.status === "failed" ? (
        <section className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5">
          <h2 className="font-[family-name:var(--font-fraunces)] text-xl">
            Recovery
          </h2>
          <p className="mt-2 text-sm text-[var(--muted)]">
            This import left rows in the catalog. Remove inserts introduced here,
            or re-import the same export to reconcile.
          </p>
          <div className="mt-4">
            <DiscardImportRowsButton importId={id} />
          </div>
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
                <dt className="text-[var(--muted)]">JSON files parsed</dt>
                <dd className="font-[family-name:var(--font-ibm)]">
                  {log.jsonFilesParsed}
                </dd>
              </div>
              <div>
                <dt className="text-[var(--muted)]">Saved items parsed</dt>
                <dd className="font-[family-name:var(--font-ibm)]">
                  {log.itemsParsed}
                </dd>
              </div>
              <div>
                <dt className="text-[var(--muted)]">Liked items parsed</dt>
                <dd className="font-[family-name:var(--font-ibm)]">
                  {log.likesParsed}
                </dd>
              </div>
              <div>
                <dt className="text-[var(--muted)]">Saves with author</dt>
                <dd className="font-[family-name:var(--font-ibm)]">
                  {authors?.savesWithAuthor ?? log.authorsFound}
                </dd>
              </div>
              <div>
                <dt className="text-[var(--muted)]">Likes with author</dt>
                <dd className="font-[family-name:var(--font-ibm)]">
                  {authors?.likesWithAuthor ?? log.likesAuthorsFound}
                </dd>
              </div>
              <div>
                <dt className="text-[var(--muted)]">Items with saved date</dt>
                <dd className="font-[family-name:var(--font-ibm)]">
                  {log.itemsWithSavedAt}
                </dd>
              </div>
              <div>
                <dt className="text-[var(--muted)]">Likes with liked date</dt>
                <dd className="font-[family-name:var(--font-ibm)]">
                  {log.likesWithLikedAt}
                </dd>
              </div>
            </dl>
          </section>

          <TypeCountsSection title="Save type counts" counts={log.typeCounts} />

          {hasLikes ? (
            <TypeCountsSection
              title="Like type counts"
              counts={log.likeTypeCounts}
            />
          ) : null}

          <FileListSection title="Saved JSON files" files={log.savedJsonFiles} />
          <FileListSection title="Liked JSON files" files={log.likedJsonFiles} />

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
