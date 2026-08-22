/**
 * Opt-in SQLite <-> Postgres library copy for ME-6.
 *
 * The Settings UI uses this same strict copy path by default; the CLI remains
 * available for offline operations. The target must be empty (or an
 * interrupted in-progress copy) and both endpoints must be explicit.
 *
 * Crash safety: SQLite targets are copied into `*.engine-migrate` then renamed
 * over the destination. Postgres targets record `engine_migration` in_progress
 * before copying; a retry wipes that incomplete library. The app refuses to
 * open an in-progress Postgres target.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import type { Pool, PoolClient } from "pg";
import {
  createPostgresPool,
  createPostgresStorage,
  createSqliteStorage,
  ensureDatabaseSchema,
} from "../src/lib/storage";
import {
  markPostgresEngineMigration,
  postgresEngineMigrationStatus,
  tryLockEngineMigration,
  unlockEngineMigration,
  wipeIncompletePostgresLibrary,
} from "../src/lib/storage/postgres/engine-migration";

type Engine = "sqlite" | "postgres";
type Scalar = string | number | boolean | Date | null;
type Row = Record<string, Scalar>;

export type EngineMigrationOptions = {
  from: Engine;
  to: Engine;
  sqlitePath: string;
  postgresUrl: string;
  postgresSchema: string;
  includeJobs: boolean;
};

export type EngineMigrationAbort = {
  afterTable?: string;
  afterPhase?: "copy" | "search";
};

export type EngineMigrationProgress = {
  phase: "preparing" | "copying" | "vectors" | "search" | "verifying" | "finalizing" | "complete";
  step: number;
  totalSteps: number;
  message: string;
  rowsCopied: number;
};

export type EngineMigrationProgressHandler = (
  progress: EngineMigrationProgress,
) => void | Promise<void>;

export class EngineMigrationAbortError extends Error {
  constructor(phase: string) {
    super(`migrate:engine aborted for test at ${phase}`);
    this.name = "EngineMigrationAbortError";
  }
}

export const SQLITE_STAGING_SUFFIX = ".engine-migrate";

type Options = EngineMigrationOptions;

type TableSpec = {
  name: string;
  columns: string[];
  timestampColumns?: string[];
  booleanColumns?: string[];
  identity?: boolean;
  optional?: boolean;
};

const CORE_TABLES: TableSpec[] = [
  {
    name: "imports",
    columns: [
      "id", "filename", "content_hash", "imported_at", "items_found",
      "items_added", "items_updated", "items_skipped", "status", "error", "notes",
    ],
    timestampColumns: ["imported_at"],
    identity: true,
  },
  {
    name: "media",
    columns: [
      "id", "media_key", "href", "shortcode", "media_type", "author_username",
      "created_at", "updated_at",
    ],
    timestampColumns: ["created_at", "updated_at"],
    identity: true,
  },
  {
    name: "saved",
    columns: [
      "media_id", "saved_at", "first_seen_import_id", "last_seen_import_id",
      "created_at", "updated_at",
    ],
    timestampColumns: ["saved_at", "created_at", "updated_at"],
  },
  {
    name: "liked",
    columns: [
      "media_id", "liked_at", "source", "first_seen_import_id",
      "last_seen_import_id", "created_at", "updated_at",
    ],
    timestampColumns: ["liked_at", "created_at", "updated_at"],
  },
  {
    name: "item_collections",
    columns: ["id", "item_id", "collection_name"],
    identity: true,
  },
  {
    name: "import_schemas",
    columns: [
      "id", "import_id", "file_path", "byte_size", "truncated_read",
      "top_level_type", "schema_json", "created_at",
    ],
    timestampColumns: ["created_at"],
    booleanColumns: ["truncated_read"],
    identity: true,
  },
  {
    name: "app_settings",
    columns: ["key", "value", "updated_at"],
    timestampColumns: ["updated_at"],
  },
  {
    name: "embedding_index_profiles",
    columns: [
      "index_name", "provider", "model", "dimensions", "endpoint", "updated_at",
    ],
    timestampColumns: ["updated_at"],
  },
];

const JOB_TABLES: TableSpec[] = [
  {
    name: "embedding_jobs",
    columns: [
      "id", "target", "state", "phase", "processed", "total",
      "current_provider", "error", "message", "cancel_requested", "worker_pid",
      "lease_expires_at", "started_at", "finished_at", "updated_at",
    ],
    timestampColumns: [
      "lease_expires_at", "started_at", "finished_at", "updated_at",
    ],
    booleanColumns: ["cancel_requested"],
    identity: true,
    optional: true,
  },
  {
    name: "import_jobs",
    columns: [
      "id", "filename", "content_hash", "spool_path", "kind", "state", "phase",
      "processed", "total", "message", "error", "details", "result",
      "import_id", "cancel_requested", "started_at", "finished_at", "updated_at",
    ],
    timestampColumns: ["started_at", "finished_at", "updated_at"],
    booleanColumns: ["cancel_requested"],
    identity: true,
    optional: true,
  },
];

const PROVIDERS = ["local", "ollama", "openai", "voyage"] as const;
const BATCH_SIZE = 1_000;

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function engineArgument(name: "from" | "to"): Engine {
  const value = argument(name);
  if (value !== "sqlite" && value !== "postgres") {
    throw new Error(`--${name} must be sqlite or postgres`);
  }
  return value;
}

function parseOptions(): EngineMigrationOptions {
  const from = engineArgument("from");
  const to = engineArgument("to");
  if (from === to) throw new Error("--from and --to must select different engines");

  const sqlitePath = argument("sqlite")?.trim();
  if (!sqlitePath) throw new Error("--sqlite=/absolute/path/to/library.db is required");
  if (!path.isAbsolute(sqlitePath)) throw new Error("--sqlite must be an absolute path");

  const postgresUrl =
    argument("postgres-url")?.trim() ??
    process.env.INSTAGRAM_SAVES_DATABASE_URL?.trim();
  if (!postgresUrl) {
    throw new Error(
      "--postgres-url=postgres://... or INSTAGRAM_SAVES_DATABASE_URL is required",
    );
  }
  const protocol = new URL(postgresUrl).protocol;
  if (protocol !== "postgres:" && protocol !== "postgresql:") {
    throw new Error("Postgres URL must use postgres:// or postgresql://");
  }

  return {
    from,
    to,
    sqlitePath,
    postgresUrl,
    postgresSchema:
      argument("postgres-schema")?.trim() ||
      process.env.INSTAGRAM_SAVES_PG_SCHEMA?.trim() ||
      "instagram_saves",
    includeJobs: process.argv.includes("--include-jobs"),
  };
}

export function sqliteStagingPath(destPath: string): string {
  return `${destPath}${SQLITE_STAGING_SUFFIX}`;
}

export function removeSqliteRelatedFiles(basePath: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const candidate = `${basePath}${suffix}`;
    if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
  }
}

export function replaceSqliteDatabaseFile(
  stagingPath: string,
  destPath: string,
): void {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const leftover = `${destPath}${suffix}`;
    if (fs.existsSync(leftover)) fs.unlinkSync(leftover);
  }
  fs.renameSync(stagingPath, destPath);
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const leftover = `${stagingPath}${suffix}`;
    if (fs.existsSync(leftover)) fs.unlinkSync(leftover);
  }
}

export function openSqliteDatabase(
  filename: string,
  role: "source" | "target",
): Database.Database {
  if (role === "source" && !fs.existsSync(filename)) {
    throw new Error(`SQLite source does not exist: ${filename}`);
  }
  if (role === "target") fs.mkdirSync(path.dirname(filename), { recursive: true });
  const sqlite = new Database(filename);
  if (role === "target") sqlite.pragma("journal_mode = DELETE");
  sqlite.pragma("foreign_keys = ON");
  sqliteVec.load(sqlite);
  ensureDatabaseSchema(sqlite);
  return sqlite;
}

export function countSqliteFileIfExists(filename: string): number {
  if (!fs.existsSync(filename)) return 0;
  const sqlite = openSqliteDatabase(filename, "source");
  try {
    return sqliteTargetCount(sqlite);
  } finally {
    sqlite.close();
  }
}

function quote(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(identifier)) {
    throw new Error(`Unsafe identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function qualified(schema: string, table: string): string {
  return `${quote(schema)}.${quote(table)}`;
}

function convertRow(row: Row, spec: TableSpec, target: Engine): Row {
  const converted = { ...row };
  for (const column of spec.timestampColumns ?? []) {
    const value = converted[column];
    if (value === null || value === undefined) continue;
    converted[column] =
      target === "postgres"
        ? value instanceof Date
          ? value
          : new Date(Number(value) * 1_000)
        : value instanceof Date
          ? Math.floor(value.getTime() / 1_000)
          : Math.floor(new Date(String(value)).getTime() / 1_000);
  }
  for (const column of spec.booleanColumns ?? []) {
    const value = converted[column];
    if (value === null || value === undefined) continue;
    converted[column] = target === "postgres" ? Boolean(value) : value ? 1 : 0;
  }
  return converted;
}

function sqliteRows(
  sqlite: Database.Database,
  spec: TableSpec,
  offset: number,
): Row[] {
  return sqlite
    .prepare(
      `SELECT ${spec.columns.map(quote).join(", ")}
       FROM ${quote(spec.name)}
       ORDER BY rowid
       LIMIT ? OFFSET ?`,
    )
    .all(BATCH_SIZE, offset) as Row[];
}

async function postgresRows(
  pool: Pool,
  spec: TableSpec,
  offset: number,
): Promise<Row[]> {
  const result = await pool.query(
    `SELECT ${spec.columns.map(quote).join(", ")}
     FROM ${quote(spec.name)}
     ORDER BY ${spec.identity ? quote("id") : spec.columns.map(quote).join(", ")}
     LIMIT $1 OFFSET $2`,
    [BATCH_SIZE, offset],
  );
  return result.rows as Row[];
}

function insertSqliteRows(
  sqlite: Database.Database,
  spec: TableSpec,
  rows: Row[],
): void {
  if (rows.length === 0) return;
  const sql = `INSERT INTO ${quote(spec.name)}
    (${spec.columns.map(quote).join(", ")})
    VALUES (${spec.columns.map(() => "?").join(", ")})`;
  const statement = sqlite.prepare(sql);
  sqlite.transaction((batch: Row[]) => {
    for (const source of batch) {
      const row = convertRow(source, spec, "sqlite");
      statement.run(...spec.columns.map((column) => row[column] ?? null));
    }
  })(rows);
}

async function insertPostgresRows(
  client: PoolClient,
  spec: TableSpec,
  rows: Row[],
): Promise<void> {
  if (rows.length === 0) return;
  const values: Scalar[] = [];
  const tuples = rows.map((source) => {
    const row = convertRow(source, spec, "postgres");
    return `(${spec.columns
      .map((column) => {
        values.push(row[column] ?? null);
        return `$${values.length}`;
      })
      .join(", ")})`;
  });
  await client.query(
    `INSERT INTO ${quote(spec.name)}
     (${spec.columns.map(quote).join(", ")})
     ${spec.identity ? "OVERRIDING SYSTEM VALUE" : ""}
     VALUES ${tuples.join(", ")}`,
    values,
  );
}

async function copyTable(
  spec: TableSpec,
  options: Options,
  sqlite: Database.Database,
  pool: Pool,
  client: PoolClient,
  abort?: EngineMigrationAbort,
  onProgress?: EngineMigrationProgressHandler,
  step = 0,
  totalSteps = 1,
): Promise<number> {
  let copied = 0;
  while (true) {
    const rows =
      options.from === "sqlite"
        ? sqliteRows(sqlite, spec, copied)
        : await postgresRows(pool, spec, copied);
    if (rows.length === 0) break;
    if (options.to === "sqlite") insertSqliteRows(sqlite, spec, rows);
    else await insertPostgresRows(client, spec, rows);
    copied += rows.length;
    await onProgress?.({
      phase: "copying",
      step,
      totalSteps,
      message: `Copying ${spec.name}: ${copied.toLocaleString()} rows`,
      rowsCopied: copied,
    });
  }
  console.log(`[migrate-engine] ${spec.name}: ${copied}`);
  if (abort?.afterTable === spec.name) {
    throw new EngineMigrationAbortError(spec.name);
  }
  return copied;
}

function sqliteVector(vector: unknown): Buffer {
  if (Buffer.isBuffer(vector)) return vector;
  if (vector instanceof Uint8Array) return Buffer.from(vector);
  throw new Error("Unexpected SQLite vector representation");
}

function postgresVector(vector: unknown): Buffer {
  const components =
    typeof vector === "string"
      ? vector.slice(1, -1).split(",").map(Number)
      : Array.isArray(vector)
        ? vector.map(Number)
        : null;
  if (!components || components.some((value) => !Number.isFinite(value))) {
    throw new Error("Unexpected Postgres vector representation");
  }
  return Buffer.from(new Float32Array(components).buffer);
}

function vectorLiteral(buffer: Buffer): string {
  const view = new Float32Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
  return `[${Array.from(view).join(",")}]`;
}

async function copyVectors(
  options: Options,
  sqlite: Database.Database,
  pool: Pool,
  client: PoolClient,
  onProgress?: EngineMigrationProgressHandler,
  step = 0,
  totalSteps = 1,
): Promise<number> {
  let total = 0;
  for (const library of ["saved", "liked"] as const) {
    for (const provider of PROVIDERS) {
      const sqliteTable = `${library}_items_vec_${provider}`;
      const postgresTable = "media_embeddings";
      let offset = 0;
      while (true) {
        const rows =
          options.from === "sqlite"
            ? (sqlite
                .prepare(
                  `SELECT item_id, embedding FROM ${quote(sqliteTable)}
                   ORDER BY item_id LIMIT ? OFFSET ?`,
                )
                .all(BATCH_SIZE, offset) as Array<{
                item_id: number;
                embedding: unknown;
              }>)
            : ((await pool.query(
                `SELECT e.media_id AS item_id, e.embedding
                 FROM ${quote(postgresTable)} e
                 JOIN ${quote(library)} m ON m.media_id=e.media_id
                 WHERE e.provider = $1 ORDER BY e.media_id LIMIT $2 OFFSET $3`,
                [provider, BATCH_SIZE, offset],
              )).rows as Array<{ item_id: number; embedding: unknown }>);
        if (rows.length === 0) break;

        if (options.to === "sqlite") {
          const statement = sqlite.prepare(
            `INSERT INTO ${quote(sqliteTable)} (item_id, embedding) VALUES (?, ?)`,
          );
          sqlite.transaction(() => {
            for (const row of rows) {
              statement.run(row.item_id, postgresVector(row.embedding));
            }
          })();
        } else {
          for (const row of rows) {
            await client.query(
              `INSERT INTO ${quote(postgresTable)} (media_id, provider, embedding)
               VALUES ($1, $2, $3::vector)
               ON CONFLICT(media_id, provider) DO UPDATE
               SET embedding=excluded.embedding`,
              [row.item_id, provider, vectorLiteral(sqliteVector(row.embedding))],
            );
          }
        }
        offset += rows.length;
        total += rows.length;
        await onProgress?.({
          phase: "vectors",
          step,
          totalSteps,
          message: `Copying vectors: ${total.toLocaleString()} rows`,
          rowsCopied: total,
        });
      }
    }
  }
  console.log(`[migrate-engine] embeddings: ${total}`);
  return total;
}

export function sqliteTargetCount(sqlite: Database.Database): number {
  const ordinary = [...CORE_TABLES, ...JOB_TABLES].reduce((sum, table) => {
    const row = sqlite
      .prepare(`SELECT count(*) AS count FROM ${quote(table.name)}`)
      .get() as { count: number };
    return sum + Number(row.count);
  }, 0);
  const searchTables = ["saved_items_fts", "liked_items_fts"];
  const vectorTables = PROVIDERS.flatMap((provider) => [
    `saved_items_vec_${provider}`,
    `liked_items_vec_${provider}`,
  ]);
  return [...searchTables, ...vectorTables].reduce((sum, table) => {
    const row = sqlite
      .prepare(`SELECT count(*) AS count FROM ${quote(table)}`)
      .get() as { count: number };
    return sum + Number(row.count);
  }, ordinary);
}

export async function postgresTargetCount(
  pool: Pool,
  postgresSchema: string,
): Promise<number> {
  const tables = [
    ...CORE_TABLES,
    ...JOB_TABLES,
    { name: "saved_items_search" },
    { name: "liked_items_search" },
    { name: "media_embeddings" },
  ];
  const expressions = tables.map(
    (table) =>
      `(SELECT count(*) FROM ${qualified(postgresSchema, table.name)})`,
  );
  const result = await pool.query(
    `SELECT (${expressions.join(" + ")})::int AS count`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function resetPostgresIdentities(client: PoolClient, specs: TableSpec[]) {
  for (const spec of specs.filter((table) => table.identity)) {
    await client.query(
      `SELECT setval(
         pg_get_serial_sequence($1, 'id'),
         COALESCE((SELECT max(id) FROM ${quote(spec.name)}), 0) + 1,
         false
       )`,
      [spec.name],
    );
  }
}

async function rebuildTargetSearch(
  options: Options,
  sqlite: Database.Database,
  pool: Pool,
  onProgress?: EngineMigrationProgressHandler,
  step = 0,
  totalSteps = 1,
) {
  const storage =
    options.to === "sqlite"
      ? createSqliteStorage(sqlite)
      : createPostgresStorage(pool);
  const saves = await storage.search.allSavesSearchRows();
  const likes = await storage.search.allLikesSearchRows();
  for (let index = 0; index < saves.length; index += 1) {
    const row = saves[index]!;
    await storage.search.upsertItemFts(row.id, row);
    if ((index + 1) % 250 === 0) {
      await onProgress?.({
        phase: "search",
        step,
        totalSteps,
        message: `Rebuilding search: ${(index + 1).toLocaleString()} of ${(saves.length + likes.length).toLocaleString()} items`,
        rowsCopied: index + 1,
      });
    }
  }
  for (let index = 0; index < likes.length; index += 1) {
    const row = likes[index]!;
    await storage.search.upsertLikedItemFts(row.id, row);
    if ((index + 1) % 250 === 0) {
      await onProgress?.({
        phase: "search",
        step,
        totalSteps,
        message: `Rebuilding search: ${(saves.length + index + 1).toLocaleString()} of ${(saves.length + likes.length).toLocaleString()} items`,
        rowsCopied: saves.length + index + 1,
      });
    }
  }
  console.log(`[migrate-engine] FTS rebuilt: ${saves.length} saves, ${likes.length} likes`);
}

function maybeAbort(abort: EngineMigrationAbort | undefined, phase: "copy" | "search") {
  if (abort?.afterPhase === phase) throw new EngineMigrationAbortError(phase);
}

export async function runEngineMigration(
  options: EngineMigrationOptions,
  abort?: EngineMigrationAbort,
  onProgress?: EngineMigrationProgressHandler,
): Promise<void> {
  console.log(`[migrate-engine] copy ${options.from} -> ${options.to}`);

  const stagingPath =
    options.to === "sqlite" ? sqliteStagingPath(options.sqlitePath) : null;
  if (stagingPath) removeSqliteRelatedFiles(stagingPath);

  const sqlite =
    options.to === "sqlite"
      ? openSqliteDatabase(stagingPath!, "target")
      : openSqliteDatabase(options.sqlitePath, "source");
  const pool = await createPostgresPool(options.postgresUrl, {
    allowIncompleteMigration: options.to === "postgres",
    postgresSchema: options.postgresSchema,
    trackLibraryStatus: false,
  });
  const client = await pool.connect();
  const specs = options.includeJobs ? [...CORE_TABLES, ...JOB_TABLES] : CORE_TABLES;
  const totalSteps = specs.length + 4;
  let postgresLocked = false;

  try {
    await onProgress?.({
      phase: "preparing",
      step: 0,
      totalSteps,
      message: `Preparing ${options.to === "postgres" ? "PostgreSQL" : "SQLite"} target`,
      rowsCopied: 0,
    });
    if (options.to === "sqlite") {
      const destCount = countSqliteFileIfExists(options.sqlitePath);
      if (destCount !== 0) {
        throw new Error(
          `Refusing non-empty sqlite target (${destCount} rows). ` +
            "Use a fresh database or use the normal wipe/reimport path.",
        );
      }
    } else {
      const locked = await tryLockEngineMigration(client);
      if (!locked) {
        throw new Error(
          "Another migrate:engine process holds the Postgres target lock.",
        );
      }
      postgresLocked = true;
      const status = await postgresEngineMigrationStatus(
        pool,
        options.postgresSchema,
      );
      if (status === "in_progress") {
        console.log(
          "[migrate-engine] wiping incomplete Postgres target from a previous interrupted copy",
        );
        await wipeIncompletePostgresLibrary(pool, options.postgresSchema);
      } else {
        const targetCount = await postgresTargetCount(
          pool,
          options.postgresSchema,
        );
        if (targetCount !== 0) {
          throw new Error(
            `Refusing non-empty postgres target (${targetCount} rows). ` +
              "Use a fresh database or use the normal wipe/reimport path.",
          );
        }
      }
      await markPostgresEngineMigration(
        pool,
        options.postgresSchema,
        "in_progress",
      );
    }

    await client.query("BEGIN");
    try {
      for (let index = 0; index < specs.length; index += 1) {
        const spec = specs[index]!;
        await copyTable(
          spec,
          options,
          sqlite,
          pool,
          client,
          abort,
          onProgress,
          index + 1,
          totalSteps,
        );
      }
      await copyVectors(
        options,
        sqlite,
        pool,
        client,
        onProgress,
        specs.length + 1,
        totalSteps,
      );
      if (options.to === "postgres") await resetPostgresIdentities(client, specs);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }

    maybeAbort(abort, "copy");
    await onProgress?.({
      phase: "search",
      step: specs.length + 2,
      totalSteps,
      message: "Rebuilding target search documents",
      rowsCopied: 0,
    });
    await rebuildTargetSearch(
      options,
      sqlite,
      pool,
      onProgress,
      specs.length + 2,
      totalSteps,
    );
    maybeAbort(abort, "search");
    const targetStorage =
      options.to === "sqlite"
        ? createSqliteStorage(sqlite)
        : createPostgresStorage(pool);
    await onProgress?.({
      phase: "verifying",
      step: specs.length + 3,
      totalSteps,
      message: "Verifying target integrity",
      rowsCopied: 0,
    });
    const integrity = await targetStorage.maintenance.checkIntegrity();
    if (!integrity.ok) throw new Error(`Target integrity failed: ${integrity.detail}`);
    if (options.to === "postgres") {
      await markPostgresEngineMigration(
        pool,
        options.postgresSchema,
        "complete",
      );
    } else {
      sqlite.close();
      replaceSqliteDatabaseFile(stagingPath!, options.sqlitePath);
    }
    await onProgress?.({
      phase: "complete",
      step: totalSteps,
      totalSteps,
      message: `Migration complete: ${integrity.detail}`,
      rowsCopied: 0,
    });
    console.log(`[migrate-engine] complete: ${integrity.detail}`);
  } catch (error) {
    if (options.to === "sqlite" && stagingPath) {
      if (sqlite.open) sqlite.close();
      removeSqliteRelatedFiles(stagingPath);
    }
    throw error;
  } finally {
    if (postgresLocked) await unlockEngineMigration(client).catch(() => undefined);
    client.release();
    await pool.end();
    if (sqlite.open) sqlite.close();
  }
}

async function main() {
  await runEngineMigration(parseOptions());
}

function invokedAsCli(): boolean {
  if (process.env.VITEST) return false;
  return process.argv.some((arg) => /migrate-engine\.(ts|js|mjs)$/.test(arg));
}

if (invokedAsCli()) {
  main().catch((error) => {
    console.error(
      `[migrate-engine] failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
