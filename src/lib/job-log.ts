/**
 * Structured one-line job logs for operators.
 * Prefixes: [import] / [search] / [embedding-worker].
 * Call only on throttled progress publishes or phase/terminal boundaries — not per item.
 */

export type JobLogChannel = "import" | "search" | "embedding-worker";

export type JobLogFields = {
  jobId?: number;
  phase?: string;
  processed?: number;
  total?: number;
  /** Extra free-form detail (keep short). */
  message?: string;
  level?: "info" | "warn" | "error";
};

function formatLine(channel: JobLogChannel, fields: JobLogFields): string {
  const parts: string[] = [`[${channel}]`];
  if (fields.jobId != null) parts.push(`job=${fields.jobId}`);
  if (fields.phase) parts.push(`phase=${fields.phase}`);
  if (
    fields.processed != null &&
    fields.total != null &&
    Number.isFinite(fields.processed) &&
    Number.isFinite(fields.total)
  ) {
    parts.push(`${fields.processed}/${fields.total}`);
  } else if (fields.processed != null) {
    parts.push(`processed=${fields.processed}`);
  }
  if (fields.message) parts.push(fields.message);
  return parts.join(" ");
}

/** Emit a single structured job log line. */
export function jobLog(channel: JobLogChannel, fields: JobLogFields = {}): void {
  const line = formatLine(channel, fields);
  const level = fields.level ?? "info";
  if (level === "error") {
    console.error(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.log(line);
}
