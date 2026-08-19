import type Database from "better-sqlite3";
import type { CatalogStore } from "../ports";
import * as queries from "../../queries";
import * as schemaCatalog from "../../schema-catalog";
import {
  applyLikedItems,
  applyParsedItems,
  persistImportSchemas,
} from "../../import/write-batches";
import { appendImportNotes } from "../../import/run-helpers";
import { countPersistedImportRows } from "../../import/partial-accounting";
import {
  discardImportInserts,
  rollbackImportInserts,
} from "../../import/rollback-partial";

/**
 * CatalogStore over the process SQLite singleton.
 * Domain modules still resolve getSqlite/getDb until ME-2 injects the port.
 * `sqlite` is retained so createSqliteStorage documents the bound handle.
 */
export function createSqliteCatalogStore(
  _sqlite: Database.Database,
): CatalogStore {
  return {
    getStats: async () => queries.getStats(),
    listSaves: (query) => queries.listSaves(query),
    listLikes: (query) => queries.listLikes(query),
    listImports: async () => queries.listImports(),
    getImportById: async (id) => queries.getImportById(id),
    listSavesFilterOptions: async () => queries.listSavesFilterOptions(),
    listLikesFilterOptions: async () => queries.listLikesFilterOptions(),

    listSchemaImportOptions: async () =>
      schemaCatalog.listSchemaImportOptions(),
    getSchemasForImport: async (importId) =>
      schemaCatalog.getSchemasForImport(importId),
    getAggregatedSchemas: async () => schemaCatalog.getAggregatedSchemas(),
    getSchemaCatalog: async (importIdParam) =>
      schemaCatalog.getSchemaCatalog(importIdParam),

    persistImportSchemas: async (importId, catalog) => {
      persistImportSchemas(importId, catalog);
    },
    applyParsedItems: (importId, items, options) =>
      applyParsedItems(importId, items, options),
    applyLikedItems: (importId, items, options) =>
      applyLikedItems(importId, items, options),
    appendImportNotes: async (importId, extra) => {
      appendImportNotes(importId, extra);
    },
    countPersistedImportRows: async (importId) =>
      countPersistedImportRows(importId),
    rollbackImportInserts: async (importId) =>
      rollbackImportInserts(importId),
    discardImportInserts: async (importId) => discardImportInserts(importId),
  };
}
