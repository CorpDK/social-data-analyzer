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
    getStatus: async () => ({
      engine: "postgres",
      displayName: "PostgreSQL",
      location,
      locationFolder: null,
      state: "up_to_date",
      appliedMigrations: 0,
      pendingMigrations: 0,
    }),
  };
}

export function clearLibraryStatusForTests(): void {
  globalForLibraryStatus.instagramSavesLibraryStatus = undefined;
}
