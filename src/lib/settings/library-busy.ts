/**
 * Detect import / embedding work that must finish (or be cancelled) before a
 * library wipe. Used by reset-library to refuse DB deletes under active writers.
 */
import type Database from "better-sqlite3";

export class LibraryBusyError extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "LibraryBusyError";
  }
}

export type BusyJobSummary = {
  kind: "import" | "embedding";
  id: number;
  state: string;
  label: string;
};

export type LibraryBusyState =
  | { busy: false }
  | {
      busy: true;
      jobs: BusyJobSummary[];
      reason: string;
    };

function tableExists(sqlite: Database.Database, name: string): boolean {
  const row = sqlite
    .prepare(
      `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`,
    )
    .get(name) as { ok: number } | undefined;
  return Boolean(row);
}

/**
 * Pending or running import/embedding jobs that own (or will own) writers.
 */
export function getLibraryBusyState(
  sqlite: Database.Database,
): LibraryBusyState {
  const jobs: BusyJobSummary[] = [];

  if (tableExists(sqlite, "import_jobs")) {
    const rows = sqlite
      .prepare(
        `SELECT id, state, filename
         FROM import_jobs
         WHERE state IN ('pending', 'running')
         ORDER BY id ASC`,
      )
      .all() as Array<{ id: number; state: string; filename: string }>;
    for (const row of rows) {
      jobs.push({
        kind: "import",
        id: row.id,
        state: row.state,
        label: row.filename || `import #${row.id}`,
      });
    }
  }

  if (tableExists(sqlite, "embedding_jobs")) {
    const rows = sqlite
      .prepare(
        `SELECT id, state, target
         FROM embedding_jobs
         WHERE state IN ('pending', 'running')
         ORDER BY id ASC`,
      )
      .all() as Array<{ id: number; state: string; target: string }>;
    for (const row of rows) {
      jobs.push({
        kind: "embedding",
        id: row.id,
        state: row.state,
        label: row.target || `reindex #${row.id}`,
      });
    }
  }

  if (jobs.length === 0) return { busy: false };

  const parts = jobs.map(
    (j) => `${j.kind} #${j.id} (${j.state}: ${j.label})`,
  );
  const reason =
    `Cannot reset library while jobs are active: ${parts.join("; ")}. ` +
    `Cancel import/reindex (or wait until they finish), then try again.`;

  return { busy: true, jobs, reason };
}

/** Throw 409-class error when wipe would race active writers. */
export function assertLibraryIdleForReset(sqlite: Database.Database): void {
  const state = getLibraryBusyState(sqlite);
  if (state.busy) {
    throw new LibraryBusyError(state.reason);
  }
}
