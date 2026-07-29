import { getSqlite, recreateEmptySearchIndexes } from "../db";
import { RESET_LIBRARY_CONFIRMATION_PHRASE } from "./reset-phrase";

export { RESET_LIBRARY_CONFIRMATION_PHRASE };

export type ResetLibraryResult = {
  ok: true;
  confirmationPhrase: typeof RESET_LIBRARY_CONFIRMATION_PHRASE;
  wiped: {
    imports: number;
    savedItems: number;
    itemCollections: number;
    embeddingProfiles: number;
    embeddingJobs: number;
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
 */
export function resetLibrary(confirmation: string): ResetLibraryResult {
  if (confirmation !== RESET_LIBRARY_CONFIRMATION_PHRASE) {
    throw new Error(
      `Confirmation phrase must be exactly "${RESET_LIBRARY_CONFIRMATION_PHRASE}"`,
    );
  }

  const sqlite = getSqlite();

  const before = {
    imports: countRows("imports"),
    savedItems: countRows("saved_items"),
    itemCollections: countRows("item_collections"),
    embeddingProfiles: tableExists("embedding_index_profiles")
      ? countRows("embedding_index_profiles")
      : 0,
    embeddingJobs: countRows("embedding_jobs"),
  };

  const wipeContent = sqlite.transaction(() => {
    // Children first — FK from item_collections → saved_items → imports.
    sqlite.exec(`DELETE FROM item_collections`);
    sqlite.exec(`DELETE FROM saved_items`);
    sqlite.exec(`DELETE FROM imports`);

    if (tableExists("embedding_index_profiles")) {
      sqlite.exec(`DELETE FROM embedding_index_profiles`);
    }

    sqlite.exec(`DELETE FROM embedding_jobs`);

    if (tableExists("sqlite_sequence")) {
      sqlite.exec(`
        DELETE FROM sqlite_sequence
        WHERE name IN (
          'imports',
          'saved_items',
          'item_collections',
          'embedding_jobs'
        )
      `);
    }
  });

  wipeContent();

  // Virtual tables (FTS5 / vec0) are recreated outside the content transaction.
  recreateEmptySearchIndexes(sqlite);

  return {
    ok: true,
    confirmationPhrase: RESET_LIBRARY_CONFIRMATION_PHRASE,
    wiped: before,
    kept: ["app_settings", "system keyring secrets", "theme (localStorage)"],
  };
}
