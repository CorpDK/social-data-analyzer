import type { Pool } from "pg";
import {
  postgresEngineMigrationStatus,
  type EngineMigrationStatus,
} from "./engine-migration";

export type PostgresSetupErrorCode =
  | "CONNECT_FAILED"
  | "PERMISSION_DENIED"
  | "EXTENSION_MISSING"
  | "MIGRATE_FAILED"
  | "SCHEMA_UNAVAILABLE"
  | "POSTGRES_MIGRATION_IN_PROGRESS";

export type PostgresPreflight = {
  state:
    | "ready"
    | "extension_missing"
    | "permission_denied"
    | "schema_unavailable"
    | "unfinished_copy";
  serverReachable: true;
  serverVersion: string;
  roleName: string;
  vector: {
    installed: boolean;
    available: boolean;
    installable: boolean;
  };
  schema: {
    name: string;
    exists: boolean;
    usable: boolean;
    creatable: boolean;
  };
  engineMigration: EngineMigrationStatus;
  code: PostgresSetupErrorCode | null;
  message: string;
};

type SqlStateError = {
  code?: unknown;
  cause?: unknown;
};

export class PostgresSetupError extends Error {
  constructor(
    readonly code: PostgresSetupErrorCode,
    message: string,
    readonly sqlState: string | null = null,
  ) {
    super(message);
    this.name = "PostgresSetupError";
  }
}

export function postgresSqlState(error: unknown): string | null {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const shaped = current as SqlStateError;
    if (typeof shaped.code === "string" && /^[0-9A-Z]{5}$/.test(shaped.code)) {
      return shaped.code;
    }
    current = shaped.cause;
  }
  return null;
}

export function classifyPostgresError(
  error: unknown,
  fallback: "connect" | "migrate",
): PostgresSetupError {
  if (error instanceof PostgresSetupError) return error;
  const sqlState = postgresSqlState(error);
  if (sqlState === "42501") {
    return new PostgresSetupError(
      "PERMISSION_DENIED",
      "This database account cannot set up the library here. Ask the database administrator for the required permissions, then try again.",
      sqlState,
    );
  }
  if (fallback === "migrate" && sqlState === "0A000") {
    return new PostgresSetupError(
      "EXTENSION_MISSING",
      "This PostgreSQL server is missing search support. Ask the database administrator to install the vector extension, then try again.",
      sqlState,
    );
  }
  if (
    fallback === "connect" ||
    sqlState?.startsWith("08") ||
    (error && typeof error === "object" &&
      ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT"].includes(
        String((error as SqlStateError).code),
      ))
  ) {
    return new PostgresSetupError(
      "CONNECT_FAILED",
      "Cannot reach the PostgreSQL server. Check the connection URL and that the server is running.",
      sqlState,
    );
  }
  return new PostgresSetupError(
    "MIGRATE_FAILED",
    "We couldn't finish updating the PostgreSQL library. Ask whoever runs the server to take a backup of this database, then try again.",
    sqlState,
  );
}

export async function inspectPostgresPreflight(
  pool: Pick<Pool, "query">,
  postgresSchema: string,
): Promise<PostgresPreflight> {
  const result = await pool.query<{
    server_version: string;
    role_name: string;
    vector_installed: boolean;
    vector_available: boolean;
    role_superuser: boolean;
    database_create: boolean;
    schema_exists: boolean;
    schema_usage: boolean;
    schema_create: boolean;
  }>(`
    SELECT
      current_setting('server_version') AS server_version,
      current_user AS role_name,
      EXISTS (
        SELECT 1 FROM pg_extension WHERE extname = 'vector'
      ) AS vector_installed,
      EXISTS (
        SELECT 1 FROM pg_available_extensions WHERE name = 'vector'
      ) AS vector_available,
      COALESCE((
        SELECT rolsuper FROM pg_roles WHERE rolname = current_user
      ), false) AS role_superuser,
      has_database_privilege(current_user, current_database(), 'CREATE')
        AS database_create,
      EXISTS (
        SELECT 1 FROM pg_namespace WHERE nspname = $1
      ) AS schema_exists,
      CASE WHEN EXISTS (
        SELECT 1 FROM pg_namespace WHERE nspname = $1
      ) THEN has_schema_privilege(current_user, $1, 'USAGE') ELSE false END
        AS schema_usage,
      CASE WHEN EXISTS (
        SELECT 1 FROM pg_namespace WHERE nspname = $1
      ) THEN has_schema_privilege(current_user, $1, 'CREATE') ELSE false END
        AS schema_create
  `, [postgresSchema]);
  const row = result.rows[0];
  if (!row) {
    throw new PostgresSetupError(
      "CONNECT_FAILED",
      "Cannot read PostgreSQL server details. Check the connection and try again.",
    );
  }

  const engineMigration = row.schema_exists
    ? await postgresEngineMigrationStatus(pool, postgresSchema)
    : "absent";
  const vector = {
    installed: row.vector_installed,
    available: row.vector_available,
    installable:
      row.vector_installed ||
      (row.vector_available && (row.role_superuser || row.database_create)),
  };
  const schema = {
    name: postgresSchema,
    exists: row.schema_exists,
    usable: row.schema_exists && row.schema_usage && row.schema_create,
    creatable: !row.schema_exists && row.database_create,
  };
  const common = {
    serverReachable: true as const,
    serverVersion: row.server_version,
    roleName: row.role_name,
    vector,
    schema,
    engineMigration,
  };

  if (!schema.usable && !schema.creatable) {
    return {
      ...common,
      state: "schema_unavailable",
      code: "SCHEMA_UNAVAILABLE",
      message: row.schema_exists
        ? `This account needs USAGE and CREATE permission on schema "${postgresSchema}".`
        : `Schema "${postgresSchema}" does not exist and this account cannot create it. Ask the database administrator to create it and grant USAGE and CREATE.`,
    };
  }

  if (engineMigration === "in_progress") {
    return {
      ...common,
      state: "unfinished_copy",
      code: "POSTGRES_MIGRATION_IN_PROGRESS",
      message:
        "A copy into PostgreSQL didn't finish. Retry the copy to clear the unfinished data and start again, or choose another target.",
    };
  }
  if (!vector.installed && !vector.available) {
    return {
      ...common,
      state: "extension_missing",
      code: "EXTENSION_MISSING",
      message:
        "This PostgreSQL server is missing search support. Ask the database administrator to install the vector extension, then try again.",
    };
  }
  if (!vector.installable) {
    return {
      ...common,
      state: "permission_denied",
      code: "PERMISSION_DENIED",
      message:
        "This database account cannot enable search support. Ask the database administrator to enable vector for this database, then try again.",
    };
  }
  return {
    ...common,
    state: "ready",
    code: null,
    message: row.vector_installed
      ? "The server is reachable and search support is ready."
      : "The server is reachable and this account can enable search support.",
  };
}

export function assertPostgresPreflightReady(
  preflight: PostgresPreflight,
  options: { allowIncompleteMigration?: boolean } = {},
): void {
  if (
    preflight.state === "unfinished_copy" &&
    options.allowIncompleteMigration
  ) {
    return;
  }
  if (preflight.code) {
    throw new PostgresSetupError(preflight.code, preflight.message);
  }
}
