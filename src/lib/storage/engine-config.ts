import fs from "node:fs";
import path from "node:path";

export type StorageEngine = "sqlite" | "postgres";
export type PostgresTenancy = "database" | "schema";

export const DEFAULT_POSTGRES_SCHEMA = "instagram_saves";

export type StorageEngineConfig =
  | { engine: "sqlite"; sqlitePath: string }
  | {
      engine: "postgres";
      postgresUrl: string;
      postgresSchema: string;
      postgresTenancy: PostgresTenancy;
      sqlitePath: string;
    };

const CONFIG_FILENAME = "storage-engine.json";

function defaultSqlitePath(): string {
  return path.resolve(
    process.env.INSTAGRAM_SAVES_DB?.trim() ||
      path.join(process.cwd(), "data", "instagram-saves.db"),
  );
}

export function storageEngineConfigPath(): string {
  return path.join(process.cwd(), "data", CONFIG_FILENAME);
}

function envConfig(): StorageEngineConfig {
  const sqlitePath = defaultSqlitePath();
  const postgresUrl = process.env.INSTAGRAM_SAVES_DATABASE_URL?.trim();
  if (postgresUrl) {
    const configuredSchema = process.env.INSTAGRAM_SAVES_PG_SCHEMA?.trim();
    const postgresSchema = validPostgresSchema(configuredSchema)
      ? configuredSchema
      : DEFAULT_POSTGRES_SCHEMA;
    const configuredTenancy = process.env.INSTAGRAM_SAVES_PG_TENANCY?.trim();
    const postgresTenancy: PostgresTenancy =
      configuredTenancy === "database" || configuredTenancy === "schema"
        ? configuredTenancy
        : configuredSchema
          ? postgresSchema === "public"
            ? "database"
            : "schema"
          : "database";
    return {
      engine: "postgres",
      postgresUrl,
      postgresSchema,
      postgresTenancy,
      sqlitePath,
    };
  }
  return { engine: "sqlite", sqlitePath };
}

function validPostgresUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "postgres:" || protocol === "postgresql:";
  } catch {
    return false;
  }
}

export function validPostgresSchema(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-z_][a-z0-9_]{0,62}$/.test(value)
  );
}

export function readStorageEngineConfig(): StorageEngineConfig {
  const filename = storageEngineConfigPath();
  if (!fs.existsSync(filename)) return envConfig();
  try {
    const parsed = JSON.parse(fs.readFileSync(filename, "utf8")) as {
      engine?: unknown;
      sqlitePath?: unknown;
      postgresUrl?: unknown;
      postgresSchema?: unknown;
      postgresTenancy?: unknown;
    };
    const sqlitePath =
      typeof parsed.sqlitePath === "string" && path.isAbsolute(parsed.sqlitePath)
        ? parsed.sqlitePath
        : defaultSqlitePath();
    if (parsed.engine === "sqlite") return { engine: "sqlite", sqlitePath };
    if (parsed.engine === "postgres" && validPostgresUrl(parsed.postgresUrl)) {
      const postgresSchema = validPostgresSchema(parsed.postgresSchema)
        ? parsed.postgresSchema
        : DEFAULT_POSTGRES_SCHEMA;
      const postgresTenancy: PostgresTenancy =
        parsed.postgresTenancy === "schema" ? "schema" : "database";
      return {
        engine: "postgres",
        postgresUrl: parsed.postgresUrl.trim(),
        postgresSchema,
        postgresTenancy,
        sqlitePath,
      };
    }
  } catch {
    // Fall through to the environment/default configuration.
  }
  return envConfig();
}

export function writeStorageEngineConfig(config: StorageEngineConfig): void {
  const filename = storageEngineConfigPath();
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporary, filename);
  fs.chmodSync(filename, 0o600);
}

export function redactPostgresUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.password) parsed.password = "••••••••";
    return parsed.toString();
  } catch {
    return "Configured PostgreSQL endpoint";
  }
}

export function storageEnginePublicStatus(config = readStorageEngineConfig()) {
  return {
    engine: config.engine,
    displayName: config.engine === "postgres" ? "PostgreSQL" : "SQLite",
    sqlitePath: config.sqlitePath,
    postgresUrl:
      config.engine === "postgres" ? redactPostgresUrl(config.postgresUrl) : null,
    postgresSchema:
      config.engine === "postgres" ? config.postgresSchema : null,
    postgresTenancy:
      config.engine === "postgres" ? config.postgresTenancy : null,
    source: fs.existsSync(storageEngineConfigPath()) ? "settings" : "environment",
  } as const;
}
