import { getSqlite, recreateEmptySearchIndexes } from "../db";
import { clearImportSpool } from "../import/spool";
import {
  assertLibraryIdleForReset,
  LibraryBusyError,
} from "./library-busy";
import { RESET_LIBRARY_CONFIRMATION_PHRASE } from "./reset-phrase";

export { RESET_LIBRARY_CONFIRMATION_PHRASE, LibraryBusyError };
export type { LibraryBusyState } from "./library-busy";

export type ResetLibraryResult = {
  ok: true;
  confirmationPhrase: typeof RESET_LIBRARY_CONFIRMATION_PHRASE;
  wiped: {
    imports: number;
    savedItems: number;
    likedItems: number;
    itemCollections: number;
    embeddingProfiles: number;
    embeddingJobs: number;
    importJobs: number;
  };
  kept: string[];
};

function tableExists(name: string): boolean {
  const row = getSqlite()
    .prepare(
      `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`,
    )
    .get(name) as { ok: number } | undefined;
  return Boolean(row);
}

function countRows(table: string): number {
  return (
    getSqlite().prepare(`SELECT count(*) AS c FROM ${table}`).get() as {
      c: number;
    }
  ).c;
}

/**
 * Irreversibly wipe Instagram/import/search content while keeping app settings
 * and system keyring secrets. Local single-user app — still requires the typed
 * confirmation phrase in the request body.
 *
 * Refuses (LibraryBusyError / HTTP 409) while import or embedding jobs are
 * pending/running so we never DELETE under active writers.
 */
export function resetLibrary(confirmation: string): ResetLibraryResult {
  if (confirmation !== RESET_LIBRARY_CONFIRMATION_PHRASE) {
    throw new Error(
      `Confirmation phrase must be exactly "${RESET_LIBRARY_CONFIRMATION_PHRASE}"`,
    );
  }

  const sqlite = getSqlite();
  assertLibraryIdleForReset(sqlite);

  const before = {
    imports: countRows("imports"),
    savedItems: countRows("saved_items"),
    likedItems: tableExists("liked_items") ? countRows("liked_items") : 0,
    itemCollections: countRows("item_collections"),
    embeddingProfiles: tableExists("embedding_index_profiles")
      ? countRows("embedding_index_profiles")
      : 0,
    embeddingJobs: countRows("embedding_jobs"),
    importJobs: tableExists("import_jobs") ? countRows("import_jobs") : 0,
  };

  const wipeContent = sqlite.transaction(() => {
    // Children first — FK from import_schemas/item_collections/liked_items → imports.
    // Clear import_jobs before imports (FK import_id → imports.id).
    if (tableExists("import_jobs")) {
      sqlite.exec(`DELETE FROM import_jobs`);
    }
    if (tableExists("import_schemas")) {
      sqlite.exec(`DELETE from import_schemas`);
    }
    sqlite.exec(`DELETE from item_collections`);
    sqlite.exec(`DELETE FROM saved_items`);
    if (tableExists("liked_items")) {
      sqlite.exec(`DELETE FROM liked_items`);
    }
    sqlite.exec(`DELETE FROM imports`);

    if (tableExists("embedding_index_profiles")) {
      sqlite.exec(`DELETE from embedding_index_profiles`);
    }

    sqlite.exec(`DELETE FROM embedding_jobs`);

    if (tableExists("sqlite_sequence")) {
      sqlite.exec(`
        DELETE FROM sqlite_sequence
        WHERE name IN (
          'imports',
          'saved_items',
          'liked_items',
          'item_collections',
          'embedding_jobs',
          'import_jobs',
          'import_schemas'
        )
      `);
    }
  });

  wipeContent();
  clearImportSpool();

  // Virtual tables (FTS5 / vec0) are recreated outside the content transaction.
  recreateEmptySearchIndexes(sqlite);

  return {
    ok: true,
    confirmationPhrase: RESET_LIBRARY_CONFIRMATION_PHRASE,
    wiped: before,
    kept: ["app_settings", "system keyring secrets", "theme (localStorage)"],
  };
}
