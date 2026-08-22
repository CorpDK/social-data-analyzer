import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import {
  DEFAULT_POSTGRES_SCHEMA,
  readStorageEngineConfig,
  redactPostgresUrl,
  validPostgresSchema,
} from "../engine-config";
import {
  markPostgresLibraryFailed,
  markPostgresLibraryReady,
  markPostgresLibraryUpdating,
} from "../library-status";
import {
  assertPostgresPreflightReady,
  classifyPostgresError,
  inspectPostgresPreflight,
  type PostgresPreflight,
} from "./preflight";
import * as schema from "./schema";

export type PostgresPool = Pool;

export type PostgresConnectionOptions = {
  allowIncompleteMigration?: boolean;
  postgresSchema?: string;
  trackLibraryStatus?: boolean;
};

const POSTGRES_MIGRATIONS_FOLDER = path.join(
  process.cwd(),
  "drizzle",
  "postgres",
);

const globalForPostgres = globalThis as unknown as {
  instagramSavesPostgresPool?: Pool;
  instagramSavesPostgresInit?: Promise<Pool>;
};

function databaseUrl(): string {
  const configured = readStorageEngineConfig();
  const value =
    configured.engine === "postgres"
      ? configured.postgresUrl
      : process.env.INSTAGRAM_SAVES_DATABASE_URL?.trim();
  if (!value) {
    throw new Error(
      "INSTAGRAM_SAVES_DATABASE_URL is required when using the Postgres backend.",
    );
  }
  const protocol = new URL(value).protocol;
  if (protocol !== "postgres:" && protocol !== "postgresql:") {
    throw new Error(
      "INSTAGRAM_SAVES_DATABASE_URL must use postgres:// or postgresql://.",
    );
  }
  return value;
}

function configuredPostgresSchema(): string {
  const configured = readStorageEngineConfig();
  return configured.engine === "postgres"
    ? configured.postgresSchema
    : DEFAULT_POSTGRES_SCHEMA;
}

function assertSchemaName(value: string): string {
  if (!validPostgresSchema(value)) {
    throw new Error(
      "PostgreSQL schema must start with a lowercase letter or underscore and contain only lowercase letters, numbers, and underscores.",
    );
  }
  return value;
}

function poolConfig(connectionString: string, postgresSchema: string, max: number) {
  return {
    connectionString,
    max,
    options: `-c search_path=${postgresSchema},public`,
    connectionTimeoutMillis: Number(
      process.env.INSTAGRAM_SAVES_POSTGRES_CONNECT_TIMEOUT_MS ?? 5_000,
    ),
    idleTimeoutMillis: max === 1 ? 1_000 : 30_000,
  };
}

async function ensurePostgresSchema(
  pool: Pool,
  postgresSchema: string,
  preflight: PostgresPreflight,
): Promise<void> {
  if (!preflight.schema.exists) {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${postgresSchema}"`);
  }
  const current = await pool.query<{ current_schema: string | null }>(
    "SELECT current_schema() AS current_schema",
  );
  if (current.rows[0]?.current_schema !== postgresSchema) {
    throw new Error(
      `PostgreSQL did not select the configured application schema "${postgresSchema}".`,
    );
  }
}

export function isPostgresConfigured(): boolean {
  return readStorageEngineConfig().engine === "postgres";
}

export async function createPostgresPool(
  connectionString = databaseUrl(),
  options: PostgresConnectionOptions = {},
): Promise<Pool> {
  const postgresSchema = assertSchemaName(
    options.postgresSchema ?? configuredPostgresSchema(),
  );
  const location = `${redactPostgresUrl(connectionString)} · schema ${postgresSchema}`;
  const trackLibraryStatus = options.trackLibraryStatus !== false;
  if (trackLibraryStatus) markPostgresLibraryUpdating(location);
  const pool = new Pool(
    poolConfig(
      connectionString,
      postgresSchema,
      Number(process.env.INSTAGRAM_SAVES_POSTGRES_POOL_MAX ?? 10),
    ),
  );
  const db = drizzle({ client: pool, schema });
  try {
    let preflight: PostgresPreflight;
    try {
      preflight = await inspectPostgresPreflight(pool, postgresSchema);
    } catch (error) {
      throw classifyPostgresError(error, "connect");
    }
    assertPostgresPreflightReady(preflight, options);
    await ensurePostgresSchema(pool, postgresSchema, preflight);
    try {
      await migrate(db, {
        migrationsFolder: POSTGRES_MIGRATIONS_FOLDER,
        migrationsSchema: postgresSchema,
      });
    } catch (error) {
      throw classifyPostgresError(error, "migrate");
    }
    await pool.query("SELECT 1");
    if (trackLibraryStatus) markPostgresLibraryReady(location);
    return pool;
  } catch (error) {
    const classified = classifyPostgresError(error, "connect");
    if (trackLibraryStatus) {
      markPostgresLibraryFailed(
        location,
        `${classified.code}${classified.sqlState ? ` (SQLSTATE ${classified.sqlState})` : ""}`,
      );
    }
    await pool.end().catch(() => undefined);
    throw classified;
  }
}

export async function preflightPostgresDatabase(
  connectionString: string,
  postgresSchema = configuredPostgresSchema(),
): Promise<PostgresPreflight> {
  assertSchemaName(postgresSchema);
  const pool = new Pool(poolConfig(connectionString, postgresSchema, 1));
  try {
    return await inspectPostgresPreflight(pool, postgresSchema);
  } catch (error) {
    throw classifyPostgresError(error, "connect");
  } finally {
    await pool.end().catch(() => undefined);
  }
}

export async function getPostgresPool(): Promise<Pool> {
  if (globalForPostgres.instagramSavesPostgresPool) {
    return globalForPostgres.instagramSavesPostgresPool;
  }
  if (!globalForPostgres.instagramSavesPostgresInit) {
    globalForPostgres.instagramSavesPostgresInit = createPostgresPool()
      .then(async (pool) => {
        globalForPostgres.instagramSavesPostgresPool = pool;
        return pool;
      })
      .catch((error) => {
        globalForPostgres.instagramSavesPostgresInit = undefined;
        throw error;
      });
  }
  return globalForPostgres.instagramSavesPostgresInit;
}

export async function closePostgres(): Promise<void> {
  const pool = globalForPostgres.instagramSavesPostgresPool;
  globalForPostgres.instagramSavesPostgresPool = undefined;
  globalForPostgres.instagramSavesPostgresInit = undefined;
  if (pool) await pool.end();
}
