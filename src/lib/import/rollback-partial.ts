/**
 * Roll back catalog rows introduced by a failed/cancelled import.
 *
 * New inserts (`first_seen_import_id = importId`) are deleted with FTS/vec
 * cleanup. Rows only *updated* by this import (`last_seen` only) are left in
 * place — re-import reconciles metadata; operators can also use the discard API.
 */
import { getSqlite } from "../db";
import { removeItemSearch, removeLikedItemSearch } from "../search/sync-fts";
import {
  countPersistedImportRows,
  type PersistedImportCounts,
} from "./partial-accounting";

export type ImportRollbackResult = {
  /** Counts before rollback. */
  before: PersistedImportCounts;
  /** Inserts removed (first_seen). */
  savesDeleted: number;
  likesDeleted: number;
  /** Residual after rollback (typically last_seen-only updates). */
  after: PersistedImportCounts;
};

/**
 * Delete saved/liked items whose first_seen points at this import.
 * Cascades `item_collections` via FK; cleans FTS + vec rows first.
 */
export function rollbackImportInserts(importId: number): ImportRollbackResult {
  const sqlite = getSqlite();
  const before = countPersistedImportRows(importId);

  const saveIds = sqlite
    .prepare(
      `SELECT media_id AS id FROM saved WHERE first_seen_import_id = ?`,
    )
    .all(importId) as Array<{ id: number }>;

  const likeIds = sqlite
    .prepare(
      `SELECT media_id AS id FROM liked WHERE first_seen_import_id = ?`,
    )
    .all(importId) as Array<{ id: number }>;

  const tx = sqlite.transaction(() => {
    for (const row of saveIds) {
      removeItemSearch(row.id, sqlite);
      sqlite.prepare(`DELETE FROM saved WHERE media_id = ?`).run(row.id);
    }
    for (const row of likeIds) {
      removeLikedItemSearch(row.id, sqlite);
      sqlite.prepare(`DELETE FROM liked WHERE media_id = ?`).run(row.id);
    }
    for (const row of [...saveIds, ...likeIds]) {
      sqlite.prepare(
        `DELETE FROM media WHERE id = ?
         AND NOT EXISTS (SELECT 1 FROM saved WHERE media_id = ?)
         AND NOT EXISTS (SELECT 1 FROM liked WHERE media_id = ?)`,
      ).run(row.id, row.id, row.id);
    }
  });
  tx();

  return {
    before,
    savesDeleted: saveIds.length,
    likesDeleted: likeIds.length,
    after: countPersistedImportRows(importId),
  };
}

/**
 * Operator discard: remove inserts from this import (same as fail-path rollback).
 * Refuses when an import_jobs row for this import is still pending/running.
 */
export function discardImportInserts(importId: number): ImportRollbackResult {
  const sqlite = getSqlite();
  const busy = sqlite
    .prepare(
      `SELECT id FROM import_jobs
       WHERE import_id = ? AND state IN ('pending', 'running')
       LIMIT 1`,
    )
    .get(importId) as { id: number } | undefined;
  if (busy) {
    throw new ImportDiscardBusyError(
      `Import job #${busy.id} is still active; cancel it before discarding rows.`,
    );
  }
  return rollbackImportInserts(importId);
}

export class ImportDiscardBusyError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = "ImportDiscardBusyError";
  }
}
