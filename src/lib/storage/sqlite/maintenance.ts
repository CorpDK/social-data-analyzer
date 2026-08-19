import type Database from "better-sqlite3";
import type { EngineInfo, MaintenanceOps } from "../ports";
import { checkSqliteIntegrity } from "../../db/integrity";
import { getLibraryBusyState, LibraryBusyError } from "../../settings/library-busy";
import { runDbMaintenance } from "../../settings/db-maintenance";
import { resetLibrary } from "../../settings/reset-library";

export { LibraryBusyError };

const SQLITE_ENGINE_INFO: EngineInfo = {
  engine: "sqlite",
  displayName: "SQLite",
  maintenanceActions: ["checkpoint", "vacuum"],
  searchTech: {
    keyword: "FTS5",
    vector: "sqlite-vec",
  },
  supportsWalCheckpoint: true,
  supportsVacuum: true,
};

export function createSqliteMaintenanceOps(
  sqlite: Database.Database,
): MaintenanceOps {
  return {
    engineInfo: async () => SQLITE_ENGINE_INFO,
    getLibraryBusyState: async (operation) =>
      getLibraryBusyState(sqlite, operation),
    runMaintenance: async (action) => runDbMaintenance(action, sqlite),
    // resetLibrary still uses getSqlite(); bind singleton before calling in tests.
    resetLibrary: async (confirmation) => resetLibrary(confirmation),
    checkIntegrity: async () => checkSqliteIntegrity(sqlite),
  };
}
