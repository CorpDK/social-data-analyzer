import path from "node:path";
import type {
  DatabaseSchemaError,
  DatabaseSchemaOutcome,
} from "../db/ddl";
import type { LibraryStatus, LibraryStatusPort } from "./ports";

type MutableLibraryStatus = LibraryStatus & {
  technicalDetail?: string;
};

const globalForLibraryStatus = globalThis as unknown as {
  instagramSavesLibraryStatus?: MutableLibraryStatus;
};

function sqliteBase(filePath: string) {
  return {
    engine: "sqlite" as const,
    displayName: "SQLite",
    location: filePath,
    locationFolder: path.dirname(filePath),
  };
}

function postgresBase(location: string) {
  return {
    engine: "postgres" as const,
    displayName: "PostgreSQL",
    location,
    locationFolder: null,
  };
}

export function markLibraryUpdating(filePath: string): void {
  globalForLibraryStatus.instagramSavesLibraryStatus = {
    ...sqliteBase(filePath),
    state: "updating",
    appliedMigrations: 0,
    pendingMigrations: 0,
  };
}

export function markLibraryReady(
  filePath: string,
  outcome: DatabaseSchemaOutcome,
): void {
  globalForLibraryStatus.instagramSavesLibraryStatus = {
    ...sqliteBase(filePath),
    state: "up_to_date",
    appliedMigrations: outcome.appliedMigrations,
    pendingMigrations: outcome.pendingMigrations,
  };
}

export function markLibraryFailed(
  filePath: string,
  error: DatabaseSchemaError,
): void {
  globalForLibraryStatus.instagramSavesLibraryStatus = {
    ...sqliteBase(filePath),
    state: error.code,
    appliedMigrations: 0,
    pendingMigrations: 0,
    technicalDetail: error.message,
  };
}

export function markPostgresLibraryUpdating(location: string): void {
  globalForLibraryStatus.instagramSavesLibraryStatus = {
    ...postgresBase(location),
    state: "updating",
    appliedMigrations: 0,
    pendingMigrations: 0,
  };
}

export function markPostgresLibraryReady(location: string): void {
  globalForLibraryStatus.instagramSavesLibraryStatus = {
    ...postgresBase(location),
    state: "up_to_date",
    appliedMigrations: 0,
    pendingMigrations: 0,
  };
}

export function markPostgresLibraryFailed(
  location: string,
  technicalDetail: string,
): void {
  globalForLibraryStatus.instagramSavesLibraryStatus = {
    ...postgresBase(location),
    state: "apply_failed",
    appliedMigrations: 0,
    pendingMigrations: 0,
    technicalDetail,
  };
}

export function currentLibraryStatus(): LibraryStatus | null {
  return globalForLibraryStatus.instagramSavesLibraryStatus ?? null;
}

export function createSqliteLibraryStatusPort(
  filePath: string,
): LibraryStatusPort {
  return {
    getStatus: async () =>
      currentLibraryStatus() ?? {
        ...sqliteBase(filePath),
        state: "up_to_date",
        appliedMigrations: 0,
        pendingMigrations: 0,
      },
  };
}

export function createPostgresLibraryStatusPort(
  location: string,
): LibraryStatusPort {
  return {
    getStatus: async () => {
      const current = currentLibraryStatus();
      return current?.engine === "postgres"
        ? current
        : {
            ...postgresBase(location),
            state: "up_to_date",
            appliedMigrations: 0,
            pendingMigrations: 0,
          };
    },
  };
}

export function clearLibraryStatusForTests(): void {
  globalForLibraryStatus.instagramSavesLibraryStatus = undefined;
}
