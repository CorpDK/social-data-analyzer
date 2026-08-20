import fs from "node:fs";
import path from "node:path";

export type StorageEngine = "sqlite" | "postgres";

export type StorageEngineConfig =
  | { engine: "sqlite"; sqlitePath: string }
  | { engine: "postgres"; postgresUrl: string; sqlitePath: string };

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
    return { engine: "postgres", postgresUrl, sqlitePath };
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

export function readStorageEngineConfig(): StorageEngineConfig {
  const filename = storageEngineConfigPath();
  if (!fs.existsSync(filename)) return envConfig();
  try {
    const parsed = JSON.parse(fs.readFileSync(filename, "utf8")) as {
      engine?: unknown;
      sqlitePath?: unknown;
      postgresUrl?: unknown;
    };
    const sqlitePath =
      typeof parsed.sqlitePath === "string" && path.isAbsolute(parsed.sqlitePath)
        ? parsed.sqlitePath
        : defaultSqlitePath();
    if (parsed.engine === "sqlite") return { engine: "sqlite", sqlitePath };
    if (parsed.engine === "postgres" && validPostgresUrl(parsed.postgresUrl)) {
      return {
        engine: "postgres",
        postgresUrl: parsed.postgresUrl.trim(),
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
    source: fs.existsSync(storageEngineConfigPath()) ? "settings" : "environment",
  } as const;
}
