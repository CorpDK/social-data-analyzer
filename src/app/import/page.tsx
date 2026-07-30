import Link from "next/link";
import { UploadForm } from "@/components/upload-form";
import { listImports } from "@/lib/queries";

export const dynamic = "force-dynamic";

function formatDate(value: Date) {
  return value.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export default function ImportPage() {
  const imports = listImports();

  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
          Periodic sync
        </p>
        <h1 className="font-[family-name:var(--font-fraunces)] text-4xl tracking-tight">
          Import exports
        </h1>
        <p className="max-w-2xl text-[var(--muted)]">
          Request a fresh Instagram data download whenever you want an update.
          Upload it here — import runs as a background job (safe to refresh),
          new saves are added, existing ones are matched by shortcode, and
          identical files refresh metadata.
        </p>
      </section>

      <UploadForm />

      <section className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5">
        <h2 className="font-[family-name:var(--font-fraunces)] text-xl">
          How to get an export
        </h2>
        <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm text-[var(--muted)]">
          <li>
            Instagram → Settings → Accounts Center → Your information and
            permissions → Download your information
          </li>
          <li>Choose your Instagram profile and export to device</li>
          <li>
            Select saved / activity data (or full export) and set format to{" "}
            <strong className="text-[var(--ink)]">JSON</strong>
          </li>
          <li>Download the zip when ready and upload it above</li>
        </ol>
      </section>

      <section
        id="import-history"
        className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5"
      >
        <h2 className="font-[family-name:var(--font-fraunces)] text-xl">
          Import history
        </h2>
        {imports.length === 0 ? (
          <p className="mt-4 text-sm text-[var(--muted)]">
            No imports recorded yet.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">
                <tr>
                  <th className="pb-2 font-medium">#</th>
                  <th className="pb-2 font-medium">File</th>
                  <th className="pb-2 font-medium">When</th>
                  <th className="pb-2 font-medium">Status</th>
                  <th className="pb-2 font-medium">Found</th>
                  <th className="pb-2 font-medium">Added</th>
                  <th className="pb-2 font-medium">Updated</th>
                  <th className="pb-2 font-medium">Skipped</th>
                  <th className="pb-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {imports.map((row) => (
                  <tr key={row.id} className="border-t border-[var(--line)]/80">
                    <td className="py-3 pr-3 font-[family-name:var(--font-ibm)]">
                      {row.id}
                    </td>
                    <td className="py-3 pr-3 font-medium">{row.filename}</td>
                    <td className="py-3 pr-3 text-[var(--muted)]">
                      {formatDate(row.importedAt)}
                    </td>
                    <td className="py-3 pr-3 capitalize">
                      {row.status}
                      {row.error ? (
                        <span className="mt-1 block text-xs text-[var(--danger)]">
                          {row.error}
                        </span>
                      ) : null}
                    </td>
                    <td className="py-3 pr-3 font-[family-name:var(--font-ibm)]">
                      {row.itemsFound}
                    </td>
                    <td className="py-3 pr-3 font-[family-name:var(--font-ibm)]">
                      {row.itemsAdded}
                    </td>
                    <td className="py-3 pr-3 font-[family-name:var(--font-ibm)]">
                      {row.itemsUpdated}
                    </td>
                    <td className="py-3 pr-3 font-[family-name:var(--font-ibm)]">
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
