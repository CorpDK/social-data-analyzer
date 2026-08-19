import Link from "next/link";
import {
  ensureJobRunner,
  type EmbeddingJobRecord,
  type EmbeddingJobState,
} from "@/lib/search/jobs";
import { getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

function formatUnix(unix: number | null | undefined): string {
  if (!unix) return "—";
  return new Date(unix * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatDuration(
  startedAt: number,
  finishedAt: number | null,
  state: EmbeddingJobState,
): string {
  const end =
    finishedAt ??
    (state === "running" || state === "pending"
      ? Math.floor(Date.now() / 1000)
      : null);
  if (end == null || end < startedAt) return "—";
  const seconds = end - startedAt;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  if (minutes < 60) return rem ? `${minutes}m ${rem}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return remMin ? `${hours}h ${remMin}m` : `${hours}h`;
}

function jobStateStyles(state: EmbeddingJobState): string {
  switch (state) {
    case "pending":
      return "bg-[var(--chip)] text-[var(--muted)]";
    case "running":
      return "bg-[var(--accent-soft)] text-[var(--accent)]";
    case "completed":
      return "bg-[var(--accent-soft)] text-[var(--accent)]";
    case "failed":
      return "bg-[var(--chip)] text-[var(--danger)]";
    case "cancelled":
      return "bg-[var(--chip)] text-[var(--muted)]";
  }
}

function messageCell(job: EmbeddingJobRecord): string {
  if (job.error) return job.error;
  if (job.message) return job.message;
  return "—";
}

export default async function IndexesHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  await ensureJobRunner();
  const storage = await getStorage();

  const { page: pageRaw } = await searchParams;
  const currentPage = Math.max(1, Number.parseInt(pageRaw ?? "1", 10) || 1);
  const { jobs: pageJobs, total, limit } = await storage.jobs.listEmbeddingJobs({
    limit: PAGE_SIZE,
    offset: (currentPage - 1) * PAGE_SIZE,
  });
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const showingFrom = total === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1;
  const showingTo = Math.min(
    (currentPage - 1) * PAGE_SIZE + pageJobs.length,
    total,
  );

  return (
    <div className="space-y-5">
      <section className="space-y-1.5">
        <Link
          href="/indexes"
          className="text-sm text-[var(--accent)] hover:underline"
        >
          ← Indexes
        </Link>
        <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
          Semantic search
        </p>
        <h1 className="font-[family-name:var(--font-fraunces)] text-3xl tracking-tight sm:text-4xl">
          Job history
        </h1>
        <p className="max-w-3xl text-sm text-[var(--muted)]">
          Past and in-flight embedding reindex jobs, newest first. Running and
          pending jobs appear with the same badges as on Indexes.
        </p>
      </section>

      <section className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-[family-name:var(--font-fraunces)] text-xl">
            Embedding jobs
          </h2>
          <p className="text-xs text-[var(--muted)]">
            {total === 0
              ? "No jobs yet"
              : `Showing ${showingFrom}–${showingTo} of ${total}`}
          </p>
        </div>

        {pageJobs.length === 0 ? (
          <p className="mt-4 text-sm text-[var(--muted)]">
            No reindex jobs recorded yet. Start one from{" "}
            <Link href="/indexes" className="text-[var(--accent)] hover:underline">
              Indexes
            </Link>
            .
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[960px] text-left text-sm">
              <thead className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">
                <tr>
                  <th className="pb-2 pr-3 font-medium">ID</th>
                  <th className="pb-2 pr-3 font-medium">Target</th>
                  <th className="pb-2 pr-3 font-medium">State</th>
                  <th className="pb-2 pr-3 font-medium">Phase</th>
                  <th className="pb-2 pr-3 font-medium">Progress</th>
                  <th className="pb-2 pr-3 font-medium">%</th>
                  <th className="pb-2 pr-3 font-medium">Message</th>
                  <th className="pb-2 pr-3 font-medium">Started</th>
                  <th className="pb-2 pr-3 font-medium">Finished</th>
                  <th className="pb-2 font-medium">Duration</th>
                </tr>
              </thead>
              <tbody>
                {pageJobs.map((job) => (
                  <tr key={job.id} className="border-t border-[var(--line)]/80">
                    <td className="py-3 pr-3 font-[family-name:var(--font-ibm)] tabular-nums">
                      {job.id}
                    </td>
                    <td className="py-3 pr-3">
                      <span className="font-medium">{job.target}</span>
                      {job.currentProvider &&
                      job.currentProvider !== job.target ? (
                        <span className="mt-0.5 block text-xs text-[var(--muted)]">
                          {job.currentProvider}
                        </span>
                      ) : null}
                    </td>
                    <td className="py-3 pr-3">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${jobStateStyles(job.state)}`}
                      >
                        {job.state}
                      </span>
                    </td>
                    <td className="py-3 pr-3 text-[var(--muted)]">{job.phase}</td>
                    <td className="py-3 pr-3 font-[family-name:var(--font-ibm)] tabular-nums">
                      {job.processed}/{job.total}
                    </td>
                    <td className="py-3 pr-3 font-[family-name:var(--font-ibm)] tabular-nums">
                      {job.percent}%
                    </td>
                    <td
                      className={`max-w-[220px] truncate py-3 pr-3 text-xs ${
                        job.error
                          ? "text-[var(--danger)]"
                          : "text-[var(--muted)]"
                      }`}
                      title={messageCell(job)}
                    >
                      {messageCell(job)}
                    </td>
                    <td className="py-3 pr-3 text-xs text-[var(--muted)]">
                      {formatUnix(job.startedAt)}
                    </td>
                    <td className="py-3 pr-3 text-xs text-[var(--muted)]">
                      {formatUnix(job.finishedAt)}
                    </td>
                    <td className="py-3 font-[family-name:var(--font-ibm)] text-xs tabular-nums text-[var(--muted)]">
                      {formatDuration(job.startedAt, job.finishedAt, job.state)}
                      {job.state === "running" ? (
                        <span className="text-[var(--muted)]">…</span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {totalPages > 1 ? (
          <nav
            className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--line)] pt-4 text-sm"
            aria-label="Job history pagination"
          >
            <p className="text-xs text-[var(--muted)]">
              Page {currentPage} of {totalPages}
            </p>
            <div className="flex flex-wrap gap-2">
              {currentPage > 1 ? (
                <Link
                  href={
                    currentPage === 2
                      ? "/indexes/history"
                      : `/indexes/history?page=${currentPage - 1}`
                  }
                  className="rounded-full border border-[var(--line)] px-3 py-1.5 text-xs font-medium text-[var(--muted)] transition hover:border-[var(--muted)] hover:text-[var(--ink)]"
                >
                  Previous
                </Link>
              ) : (
                <span className="rounded-full border border-[var(--line)] px-3 py-1.5 text-xs font-medium opacity-40">
                  Previous
                </span>
              )}
              {currentPage < totalPages ? (
                <Link
                  href={`/indexes/history?page=${currentPage + 1}`}
                  className="rounded-full border border-[var(--line)] px-3 py-1.5 text-xs font-medium text-[var(--muted)] transition hover:border-[var(--muted)] hover:text-[var(--ink)]"
                >
                  Next
                </Link>
              ) : (
                <span className="rounded-full border border-[var(--line)] px-3 py-1.5 text-xs font-medium opacity-40">
                  Next
                </span>
              )}
            </div>
          </nav>
        ) : null}
      </section>
    </div>
  );
}
