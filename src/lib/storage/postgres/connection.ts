import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import {
  readStorageEngineConfig,
  redactPostgresUrl,
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

export function isPostgresConfigured(): boolean {
  return readStorageEngineConfig().engine === "postgres";
}

export async function createPostgresPool(
  connectionString = databaseUrl(),
  options: {
    allowIncompleteMigration?: boolean;
    trackLibraryStatus?: boolean;
  } = {},
): Promise<Pool> {
  const location = redactPostgresUrl(connectionString);
  const trackLibraryStatus = options.trackLibraryStatus !== false;
  if (trackLibraryStatus) markPostgresLibraryUpdating(location);
  const pool = new Pool({
    connectionString,
    max: Number(process.env.INSTAGRAM_SAVES_POSTGRES_POOL_MAX ?? 10),
    connectionTimeoutMillis: Number(
      process.env.INSTAGRAM_SAVES_POSTGRES_CONNECT_TIMEOUT_MS ?? 5_000,
    ),
    idleTimeoutMillis: 30_000,
  });
  const db = drizzle({ client: pool, schema });
  try {
    let preflight: PostgresPreflight;
    try {
      preflight = await inspectPostgresPreflight(pool);
    } catch (error) {
      throw classifyPostgresError(error, "connect");
    }
    assertPostgresPreflightReady(preflight, options);
    try {
      await migrate(db, { migrationsFolder: POSTGRES_MIGRATIONS_FOLDER });
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
): Promise<PostgresPreflight> {
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: Number(
      process.env.INSTAGRAM_SAVES_POSTGRES_CONNECT_TIMEOUT_MS ?? 5_000,
    ),
    idleTimeoutMillis: 1_000,
  });
  try {
    return await inspectPostgresPreflight(pool);
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
