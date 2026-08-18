import type Database from "better-sqlite3";

/**
 * Run SQLite's full integrity check. Returns ok + the first failure line
 * (or "ok") so fault-injection / soak suites can assert crash-safety without
 * parsing pragma output by hand.
 */
export function checkSqliteIntegrity(sqlite: Database.Database): {
  ok: boolean;
  detail: string;
} {
  const rows = sqlite.pragma("integrity_check") as Array<{
    integrity_check: string;
  }>;
  const detail = rows[0]?.integrity_check ?? "missing integrity_check result";
  return { ok: detail === "ok", detail };
}
