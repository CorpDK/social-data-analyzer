import type { Pool } from "pg";
import { clearImportSpool } from "../../import/spool";
import {
  LibraryBusyError,
  type LibraryBusyState,
} from "../../settings/library-busy";
import { RESET_LIBRARY_CONFIRMATION_PHRASE } from "../../settings/reset-phrase";
import type { EngineInfo, MaintenanceOps } from "../ports";

export { LibraryBusyError };

const POSTGRES_ENGINE_INFO: EngineInfo = {
  engine: "postgres",
  displayName: "PostgreSQL",
  maintenanceActions: ["vacuum"],
  searchTech: {
    keyword: "PostgreSQL full-text search",
    vector: "pgvector",
  },
  supportsWalCheckpoint: false,
  supportsVacuum: true,
};

async function busyState(
  pool: Pool,
  operation = "reset library",
): Promise<LibraryBusyState> {
  const result = await pool.query<{
    kind: "import" | "embedding";
    id: number;
    state: string;
    label: string;
  }>(
    `SELECT 'import'::text AS kind, id, state, filename AS label
       FROM import_jobs WHERE state IN ('pending','running')
     UNION ALL
     SELECT 'embedding'::text AS kind, id, state, target AS label
       FROM embedding_jobs WHERE state IN ('pending','running')
     ORDER BY id`,
  );
  if (result.rows.length === 0) return { busy: false };
  const jobs = result.rows;
  return {
    busy: true,
    jobs,
    reason:
      `Cannot ${operation} while jobs are active: ` +
      jobs
        .map((job) => `${job.kind} #${job.id} (${job.state}: ${job.label})`)
        .join("; ") +
      ". Cancel import/reindex (or wait until they finish), then try again.",
  };
}

async function assertIdle(pool: Pool, operation: string): Promise<void> {
  const state = await busyState(pool, operation);
  if (state.busy) throw new LibraryBusyError(state.reason);
}

export function createPostgresMaintenanceOps(pool: Pool): MaintenanceOps {
  return {
    engineInfo: async () => POSTGRES_ENGINE_INFO,
    getLibraryBusyState: (operation) => busyState(pool, operation),
    runMaintenance: async (action) => {
      if (action !== "vacuum") {
        throw new Error("PostgreSQL does not expose a manual WAL checkpoint.");
      }
      await assertIdle(pool, "run VACUUM (ANALYZE)");
      const started = Date.now();
      await pool.query("VACUUM (ANALYZE)");
      const size = await pool.query<{ bytes: string }>(
        "SELECT pg_database_size(current_database())::text AS bytes",
      );
      return {
        ok: true,
        action,
        vacuumMs: Date.now() - started,
        pageCount: 0,
        freelistCount: 0,
        pageSize: Number(size.rows[0]?.bytes ?? 0),
      };
    },
    resetLibrary: async (confirmation) => {
      if (confirmation !== RESET_LIBRARY_CONFIRMATION_PHRASE) {
        throw new Error(
          `Confirmation phrase must be exactly "${RESET_LIBRARY_CONFIRMATION_PHRASE}"`,
        );
      }
      await assertIdle(pool, "reset library");
      const counts = await pool.query<{
        imports: number;
        saved_items: number;
        liked_items: number;
        item_collections: number;
        embedding_profiles: number;
        embedding_jobs: number;
        import_jobs: number;
      }>(
        `SELECT
          (SELECT count(*)::int FROM imports) AS imports,
          (SELECT count(*)::int FROM saved) AS saved_items,
          (SELECT count(*)::int FROM liked) AS liked_items,
          (SELECT count(*)::int FROM item_collections) AS item_collections,
          (SELECT count(*)::int FROM embedding_index_profiles) AS embedding_profiles,
          (SELECT count(*)::int FROM embedding_jobs) AS embedding_jobs,
          (SELECT count(*)::int FROM import_jobs) AS import_jobs`,
      );
      const before = counts.rows[0]!;
      await pool.query(
        `TRUNCATE TABLE
          media_embeddings,
          saved_items_search, liked_items_search,
          import_schemas, item_collections, import_jobs, embedding_jobs,
          embedding_index_profiles, saved, liked, media, imports
         RESTART IDENTITY CASCADE`,
      );
      clearImportSpool();
      return {
        ok: true,
        confirmationPhrase: RESET_LIBRARY_CONFIRMATION_PHRASE,
        wiped: {
          imports: before.imports,
          savedItems: before.saved_items,
          likedItems: before.liked_items,
          itemCollections: before.item_collections,
          embeddingProfiles: before.embedding_profiles,
          embeddingJobs: before.embedding_jobs,
          importJobs: before.import_jobs,
        },
        kept: ["app_settings", "system keyring secrets", "theme (localStorage)"],
      };
    },
    checkIntegrity: async () => {
      const result = await pool.query<{
        orphan_collections: number;
        orphan_schemas: number;
        orphan_save_search: number;
        orphan_like_search: number;
      }>(
        `SELECT
          (SELECT count(*)::int FROM item_collections c
             WHERE NOT EXISTS (SELECT 1 FROM saved i WHERE i.media_id=c.item_id))
             AS orphan_collections,
          (SELECT count(*)::int FROM import_schemas s
             WHERE NOT EXISTS (SELECT 1 FROM imports i WHERE i.id=s.import_id))
             AS orphan_schemas,
          (SELECT count(*)::int FROM saved_items_search s
             WHERE NOT EXISTS (SELECT 1 FROM saved i WHERE i.media_id=s.item_id))
             AS orphan_save_search,
          (SELECT count(*)::int FROM liked_items_search s
             WHERE NOT EXISTS (SELECT 1 FROM liked i WHERE i.media_id=s.item_id))
             AS orphan_like_search`,
      );
      const row = result.rows[0]!;
      const total =
        row.orphan_collections +
        row.orphan_schemas +
        row.orphan_save_search +
        row.orphan_like_search;
      return {
        ok: total === 0,
        detail:
          total === 0
            ? "PostgreSQL foreign-key and search-document checks passed."
            : `${total} orphaned relational/search row(s) detected.`,
      };
    },
  };
}
