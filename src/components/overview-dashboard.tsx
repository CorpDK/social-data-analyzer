import Link from "next/link";
import { getStats } from "@/lib/queries";

function formatDate(value: Date | null | undefined) {
  if (!value) return "—";
  return value.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function OverviewDashboard() {
  const stats = getStats();

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
          Library
        </p>
        <h1 className="max-w-2xl font-[family-name:var(--font-fraunces)] text-4xl leading-tight tracking-tight sm:text-5xl">
          Your saved posts and reels, searchable offline with FTS5 + vectors.
        </h1>
        <p className="max-w-2xl text-[var(--muted)]">
          Load periodic Instagram data exports. Each import merges new items,
          refreshes the search index, and leaves unchanged rows untouched.
        </p>
        <div className="flex flex-wrap gap-3 pt-2">
          <Link
            href="/import"
            className="rounded-full bg-[var(--accent)] px-5 py-2.5 text-sm font-medium text-white hover:brightness-110"
          >
            Import export
          </Link>
          <Link
            href="/saves"
            className="rounded-full border border-[var(--line)] bg-[var(--surface)] px-5 py-2.5 text-sm font-medium text-[var(--ink)] hover:border-[var(--accent)]"
          >
            Browse saves
          </Link>
          <Link
            href="/likes"
            className="rounded-full border border-[var(--line)] bg-[var(--surface)] px-5 py-2.5 text-sm font-medium text-[var(--ink)] hover:border-[var(--accent)]"
          >
            Browse likes
          </Link>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {[
          { label: "Saved items", value: stats.totalItems },
          { label: "Liked items", value: stats.totalLikes },
          { label: "Posts saved", value: stats.posts },
          { label: "Reels saved", value: stats.reels },
          { label: "Imports", value: stats.importCount },
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

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5">
          <h2 className="font-[family-name:var(--font-fraunces)] text-xl">
            Top creators (saves)
          </h2>
          {stats.topAuthors.length === 0 ? (
            <p className="mt-4 text-sm text-[var(--muted)]">
              No data yet. Import an export to populate this list.
            </p>
          ) : (
            <ul className="mt-4 space-y-2">
              {stats.topAuthors.map((author) => (
                <li
                  key={author.authorUsername}
                  className="flex items-center justify-between gap-3 border-b border-[var(--line)]/70 py-2 last:border-0"
                >
                  <Link
                    href={`/saves?author=${encodeURIComponent(author.authorUsername)}`}
                    className="font-medium hover:text-[var(--accent)]"
                  >
                    @{author.authorUsername}
                  </Link>
                  <span className="font-[family-name:var(--font-ibm)] text-xs text-[var(--muted)]">
                    {author.total}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5">
          <h2 className="font-[family-name:var(--font-fraunces)] text-xl">
            Top creators (likes)
          </h2>
          {stats.topLikedAuthors.length === 0 ? (
            <p className="mt-4 text-sm text-[var(--muted)]">
              No liked creators yet. Import an export that includes likes.
            </p>
          ) : (
            <ul className="mt-4 space-y-2">
              {stats.topLikedAuthors.map((author) => (
                <li
                  key={author.authorUsername}
                  className="flex items-center justify-between gap-3 border-b border-[var(--line)]/70 py-2 last:border-0"
                >
                  <Link
                    href={`/likes?author=${encodeURIComponent(author.authorUsername)}`}
                    className="font-medium hover:text-[var(--accent)]"
                  >
                    @{author.authorUsername}
                  </Link>
                  <span className="font-[family-name:var(--font-ibm)] text-xs text-[var(--muted)]">
                    {author.total}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 lg:col-span-2">
          <h2 className="font-[family-name:var(--font-fraunces)] text-xl">
            Collections
          </h2>
          {stats.collections.length === 0 ? (
            <p className="mt-4 text-sm text-[var(--muted)]">
              Named collections appear when present in the export.
            </p>
          ) : (
            <ul className="mt-4 grid gap-2 sm:grid-cols-2">
              {stats.collections.map((collection) => (
                <li
                  key={collection.collectionName}
                  className="flex items-center justify-between gap-3 border-b border-[var(--line)]/70 py-2 last:border-0"
                >
                  <Link
                    href={`/saves?collection=${encodeURIComponent(collection.collectionName)}`}
                    className="font-medium hover:text-[var(--accent)]"
                  >
                    {collection.collectionName}
                  </Link>
                  <span className="font-[family-name:var(--font-ibm)] text-xs text-[var(--muted)]">
                    {collection.total}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-[family-name:var(--font-fraunces)] text-xl">
            Recent imports
          </h2>
          <Link href="/import" className="text-sm text-[var(--accent)]">
            Manage imports
          </Link>
        </div>
        {stats.recentImports.length === 0 ? (
          <p className="mt-4 text-sm text-[var(--muted)]">No imports yet.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">
                <tr>
                  <th className="pb-2 font-medium">File</th>
                  <th className="pb-2 font-medium">When</th>
                  <th className="pb-2 font-medium">Status</th>
                  <th className="pb-2 font-medium">Added</th>
                  <th className="pb-2 font-medium">Updated</th>
                  <th className="pb-2 font-medium">Skipped</th>
                  <th className="pb-2 font-medium">Log</th>
                </tr>
              </thead>
              <tbody>
                {stats.recentImports.map((row) => (
                  <tr
                    key={row.id}
                    className="border-t border-[var(--line)]/80"
                  >
                    <td className="py-3 pr-3 font-medium">{row.filename}</td>
                    <td className="py-3 pr-3 text-[var(--muted)]">
                      {formatDate(row.importedAt)}
                    </td>
                    <td className="py-3 pr-3 capitalize">{row.status}</td>
                    <td className="py-3 pr-3 font-[family-name:var(--font-ibm)]">
                      {row.itemsAdded}
                    </td>
                    <td className="py-3 pr-3 font-[family-name:var(--font-ibm)]">
                      {row.itemsUpdated}
                    </td>
                    <td className="py-3 font-[family-name:var(--font-ibm)]">
                      {row.itemsSkipped}
                    </td>
                    <td className="py-3">
                      <Link
                        href={`/imports/${row.id}`}
                        className="text-[var(--accent)] hover:underline"
                      >
                        Details
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
