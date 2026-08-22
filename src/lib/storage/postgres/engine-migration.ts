/**
 * Opt-in migrate:engine crash marker for Postgres targets.
 *
 * Not a Drizzle catalog table: it is created only by the migration tool so a
 * killed copy cannot look like a normal library. The app refuses in_progress.
 */
import type { Pool, PoolClient } from "pg";
import { validPostgresSchema } from "../engine-config";

export const ENGINE_MIGRATION_TABLE = "engine_migration";
export const ENGINE_MIGRATION_ADVISORY_LOCK = 8_723_640_1;

export const POSTGRES_LIBRARY_TABLES = [
  "media_embeddings",
  "saved_items_search",
  "liked_items_search",
  "import_schemas",
  "item_collections",
  "import_jobs",
  "embedding_jobs",
  "embedding_index_profiles",
  "saved",
  "liked",
  "media",
  "imports",
  "app_settings",
] as const;

export type EngineMigrationStatus = "absent" | "in_progress" | "complete";

type Queryable = Pick<Pool, "query">;

function quoteSchema(schema: string): string {
  if (!validPostgresSchema(schema)) {
    throw new Error(`Unsafe PostgreSQL schema: ${schema}`);
  }
  return `"${schema}"`;
}

function qualified(schema: string, table: string): string {
  return `${quoteSchema(schema)}."${table}"`;
}

export const INCOMPLETE_ENGINE_MIGRATION_MESSAGE =
  "Refusing to open a Postgres library with an incomplete migrate:engine copy. " +
  "Re-run `pnpm migrate:engine` with the same flags (it wipes an in-progress target) " +
  "or choose another schema. Do not point the app at this schema until the copy completes.";

export class IncompleteEngineMigrationError extends Error {
  readonly code = "POSTGRES_MIGRATION_IN_PROGRESS" as const;

  constructor() {
    super(INCOMPLETE_ENGINE_MIGRATION_MESSAGE);
    this.name = "IncompleteEngineMigrationError";
  }
}

export async function postgresEngineMigrationStatus(
  db: Queryable,
  schema: string,
): Promise<EngineMigrationStatus> {
  const present = await db.query<{ name: string | null }>(
    "SELECT to_regclass($1)::text AS name",
    [`${schema}.${ENGINE_MIGRATION_TABLE}`],
  );
  if (!present.rows[0]?.name) return "absent";
  const result = await db.query<{ status: string }>(
    `SELECT status FROM ${qualified(schema, ENGINE_MIGRATION_TABLE)} WHERE id = 1`,
  );
  const status = result.rows[0]?.status;
  if (status === "in_progress" || status === "complete") return status;
  return "absent";
}

export async function assertPostgresMigrationUsable(
  db: Queryable,
  schema: string,
): Promise<void> {
  const status = await postgresEngineMigrationStatus(db, schema);
  if (status === "in_progress") {
    throw new IncompleteEngineMigrationError();
  }
}

export async function markPostgresEngineMigration(
  db: Queryable,
  schema: string,
  status: "in_progress" | "complete",
): Promise<void> {
  const table = qualified(schema, ENGINE_MIGRATION_TABLE);
  await db.query(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id integer PRIMARY KEY CHECK (id = 1),
      status text NOT NULL CHECK (status IN ('in_progress', 'complete')),
      started_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz
    )
  `);
  if (status === "in_progress") {
    await db.query(
      `INSERT INTO ${table} (id, status, started_at, finished_at)
       VALUES (1, 'in_progress', now(), NULL)
       ON CONFLICT (id) DO UPDATE
         SET status = 'in_progress',
             started_at = now(),
             finished_at = NULL`,
    );
    return;
  }
  const updated = await db.query(
    `UPDATE ${table}
     SET status = 'complete', finished_at = now()
     WHERE id = 1`,
  );
  if (updated.rowCount !== 1) {
    throw new Error("Failed to mark migrate:engine complete");
  }
}

export async function wipeIncompletePostgresLibrary(
  db: Queryable,
  schema: string,
): Promise<void> {
  await db.query(
    `TRUNCATE TABLE ${POSTGRES_LIBRARY_TABLES.map((name) => qualified(schema, name)).join(", ")}
     RESTART IDENTITY CASCADE`,
  );
  await db.query(
    `DROP TABLE IF EXISTS ${qualified(schema, ENGINE_MIGRATION_TABLE)}`,
  );
}

export async function tryLockEngineMigration(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_lock($1) AS locked",
    [ENGINE_MIGRATION_ADVISORY_LOCK],
  );
  return result.rows[0]?.locked === true;
}

export async function unlockEngineMigration(client: PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_unlock($1)", [
    ENGINE_MIGRATION_ADVISORY_LOCK,
  ]);
}
