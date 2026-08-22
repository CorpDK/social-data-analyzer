import path from "node:path";
import {
  countSqliteFileIfExists,
  postgresTargetCount,
  runEngineMigration,
  type EngineMigrationProgress,
} from "../../../scripts/migrate-engine";
import { publishJobEvent } from "../sse";
import {
  createPostgresPool,
  getStorage,
  readStorageEngineConfig,
  storageEnginePublicStatus,
  switchStorageEngine,
  type StorageEngineConfig,
} from "./index";
import {
  preflightPostgresDatabase,
} from "./postgres/connection";
import {
  postgresEngineMigrationStatus,
} from "./postgres/engine-migration";
import {
  PostgresSetupError,
  type PostgresPreflight,
  type PostgresSetupErrorCode,
} from "./postgres/preflight";
import { redactPostgresUrl } from "./engine-config";

export const ENGINE_SWITCH_CHANNEL = "engine-switch";
export const FRESH_SWITCH_CONFIRMATION = "SWITCH EMPTY";

export type EngineSwitchState =
  | "idle"
  | "running"
  | "completed"
  | "failed";

export type EngineSwitchStatus = {
  state: EngineSwitchState;
  action: "migrate" | "fresh" | null;
  sourceEngine: "sqlite" | "postgres";
  targetEngine: "sqlite" | "postgres" | null;
  phase: string;
  step: number;
  totalSteps: number;
  percent: number;
  message: string;
  error: string | null;
  errorCode: PostgresSetupErrorCode | "COPY_FAILED" | null;
  rowsCopied: number;
  startedAt: number | null;
  finishedAt: number | null;
};

export class EngineSwitchError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "ENGINE_SWITCH_REJECTED",
  ) {
    super(message);
    this.name = "EngineSwitchError";
  }
}

const globalForSwitch = globalThis as unknown as {
  instagramSavesEngineSwitch?: EngineSwitchStatus;
};

function initialStatus(): EngineSwitchStatus {
  return {
    state: "idle",
    action: null,
    sourceEngine: readStorageEngineConfig().engine,
    targetEngine: null,
    phase: "idle",
    step: 0,
    totalSteps: 0,
    percent: 0,
    message: "No engine switch is running.",
    error: null,
    errorCode: null,
    rowsCopied: 0,
    startedAt: null,
    finishedAt: null,
  };
}

export function getEngineSwitchStatus(): EngineSwitchStatus {
  if (!globalForSwitch.instagramSavesEngineSwitch) {
    globalForSwitch.instagramSavesEngineSwitch = initialStatus();
  }
  return globalForSwitch.instagramSavesEngineSwitch;
}

function updateStatus(update: Partial<EngineSwitchStatus>): EngineSwitchStatus {
  const next = { ...getEngineSwitchStatus(), ...update };
  globalForSwitch.instagramSavesEngineSwitch = next;
  publishJobEvent(ENGINE_SWITCH_CHANNEL, true);
  return next;
}

export function isEngineSwitchRunning(): boolean {
  return getEngineSwitchStatus().state === "running";
}

export function engineSwitchBusyMessage(operation: string): string {
  return `Cannot ${operation} while a storage engine migration is running. Wait for it to finish, then try again.`;
}

type EngineTargetInput = {
  engine?: unknown;
  postgresUrl?: unknown;
  sqlitePath?: unknown;
};

export function parseEngineTarget(
  input: EngineTargetInput,
  current = readStorageEngineConfig(),
): StorageEngineConfig {
  if (input.engine !== "sqlite" && input.engine !== "postgres") {
    throw new EngineSwitchError("Target engine must be sqlite or postgres.");
  }
  if (input.engine === current.engine) {
    throw new EngineSwitchError("Choose the other storage engine.");
  }
  if (input.engine === "postgres") {
    if (typeof input.postgresUrl !== "string" || !input.postgresUrl.trim()) {
      throw new EngineSwitchError("A PostgreSQL connection URL is required.");
    }
    let protocol: string;
    try {
      protocol = new URL(input.postgresUrl).protocol;
    } catch {
      throw new EngineSwitchError("PostgreSQL connection URL is invalid.");
    }
    if (protocol !== "postgres:" && protocol !== "postgresql:") {
      throw new EngineSwitchError("PostgreSQL URL must use postgres:// or postgresql://.");
    }
    return {
      engine: "postgres",
      postgresUrl: input.postgresUrl.trim(),
      sqlitePath: current.sqlitePath,
    };
  }

  if (typeof input.sqlitePath !== "string" || !input.sqlitePath.trim()) {
    throw new EngineSwitchError("An absolute SQLite target path is required.");
  }
  if (!path.isAbsolute(input.sqlitePath)) {
    throw new EngineSwitchError("SQLite target path must be absolute.");
  }
  return { engine: "sqlite", sqlitePath: path.normalize(input.sqlitePath) };
}

function progressPercent(progress: EngineMigrationProgress): number {
  if (progress.totalSteps <= 0) return 0;
  return Math.min(99, Math.round((progress.step / progress.totalSteps) * 100));
}

async function assertCurrentLibraryIdle(): Promise<void> {
  const storage = await getStorage();
  const busy = await storage.maintenance.getLibraryBusyState("migrate storage engines");
  if (busy.busy) {
    throw new EngineSwitchError(busy.reason, 409, "LIBRARY_BUSY");
  }
}

async function assertTargetEmpty(target: StorageEngineConfig): Promise<void> {
  if (target.engine === "sqlite") {
    const count = countSqliteFileIfExists(target.sqlitePath);
    if (count !== 0) {
      throw new EngineSwitchError(
        `SQLite target is not empty (${count} rows). Choose an unused path.`,
        409,
        "TARGET_NOT_EMPTY",
      );
    }
    return;
  }
  const pool = await createPostgresPool(target.postgresUrl, {
    trackLibraryStatus: false,
  });
  try {
    const marker = await postgresEngineMigrationStatus(pool);
    if (marker === "in_progress") {
      throw new EngineSwitchError(
        "This PostgreSQL target contains an incomplete migration. Use Migrate to retry it, or recreate the database before starting fresh.",
        409,
        "POSTGRES_MIGRATION_IN_PROGRESS",
      );
    }
    const count = await postgresTargetCount(pool);
    if (count !== 0) {
      throw new EngineSwitchError(
        `PostgreSQL target is not empty (${count} rows). Choose an unused database.`,
        409,
        "TARGET_NOT_EMPTY",
      );
    }
  } finally {
    await pool.end();
  }
}

async function activateTarget(target: StorageEngineConfig): Promise<void> {
  updateStatus({
    phase: "switching",
    message: `Activating ${target.engine === "postgres" ? "PostgreSQL" : "SQLite"}`,
    percent: 99,
  });
  await switchStorageEngine(target);
}

function failSwitch(error: unknown): void {
  const failure =
    error instanceof PostgresSetupError
      ? { message: error.message, code: error.code }
      : error instanceof EngineSwitchError
        ? { message: error.message, code: error.code }
        : {
            message:
              "We couldn't finish copying your library. Ask whoever runs the database to take a backup before you try again.",
            code: "COPY_FAILED",
          };
  updateStatus({
    state: "failed",
    phase: "failed",
    error: failure.message,
    errorCode: failure.code as EngineSwitchStatus["errorCode"],
    message: "Storage engine switch failed.",
    finishedAt: Date.now(),
  });
}

export async function startEngineMigration(
  targetInput: EngineTargetInput,
): Promise<EngineSwitchStatus> {
  if (isEngineSwitchRunning()) {
    throw new EngineSwitchError(
      "A storage engine switch is already running.",
      409,
      "ENGINE_SWITCH_BUSY",
    );
  }
  const source = readStorageEngineConfig();
  const target = parseEngineTarget(targetInput, source);
  updateStatus({
    state: "running",
    action: "migrate",
    sourceEngine: source.engine,
    targetEngine: target.engine,
    phase: "preparing",
    step: 0,
    totalSteps: 0,
    percent: 0,
    message: "Checking active jobs and target readiness",
    error: null,
    errorCode: null,
    rowsCopied: 0,
    startedAt: Date.now(),
    finishedAt: null,
  });

  try {
    await assertCurrentLibraryIdle();
  } catch (error) {
    failSwitch(error);
    throw error;
  }

  void (async () => {
    try {
      await runEngineMigration(
        {
          from: source.engine,
          to: target.engine,
          sqlitePath:
            source.engine === "sqlite" ? source.sqlitePath : target.sqlitePath,
          postgresUrl:
            source.engine === "postgres"
              ? source.postgresUrl
              : target.engine === "postgres"
                ? target.postgresUrl
                : "",
          includeJobs: false,
        },
        undefined,
        (progress) => {
          updateStatus({
            phase: progress.phase,
            step: progress.step,
            totalSteps: progress.totalSteps,
            percent: progressPercent(progress),
            message: progress.message,
            rowsCopied: progress.rowsCopied,
          });
        },
      );
      await activateTarget(target);
      updateStatus({
        state: "completed",
        phase: "complete",
        step: getEngineSwitchStatus().totalSteps,
        percent: 100,
        message: `${target.engine === "postgres" ? "PostgreSQL" : "SQLite"} is active. Your library, settings, and vectors were migrated.`,
        error: null,
        finishedAt: Date.now(),
      });
    } catch (error) {
      failSwitch(error);
    }
  })();

  return getEngineSwitchStatus();
}

export async function switchToEmptyEngine(
  targetInput: EngineTargetInput & { confirmation?: unknown },
): Promise<EngineSwitchStatus> {
  if (targetInput.confirmation !== FRESH_SWITCH_CONFIRMATION) {
    throw new EngineSwitchError(
      `Confirmation phrase must be exactly "${FRESH_SWITCH_CONFIRMATION}".`,
      400,
      "CONFIRMATION_REQUIRED",
    );
  }
  if (isEngineSwitchRunning()) {
    throw new EngineSwitchError(
      "A storage engine switch is already running.",
      409,
      "ENGINE_SWITCH_BUSY",
    );
  }
  const source = readStorageEngineConfig();
  const target = parseEngineTarget(targetInput, source);
  updateStatus({
    state: "running",
    action: "fresh",
    sourceEngine: source.engine,
    targetEngine: target.engine,
    phase: "preparing",
    step: 0,
    totalSteps: 2,
    percent: 0,
    message: "Checking active jobs and empty target",
    error: null,
    errorCode: null,
    rowsCopied: 0,
    startedAt: Date.now(),
    finishedAt: null,
  });
  try {
    await assertCurrentLibraryIdle();
    await assertTargetEmpty(target);
    await activateTarget(target);
    return updateStatus({
      state: "completed",
      phase: "complete",
      step: 2,
      percent: 100,
      message: `${target.engine === "postgres" ? "PostgreSQL" : "SQLite"} is active with an empty library. Import an Instagram export when ready.`,
      error: null,
      finishedAt: Date.now(),
    });
  } catch (error) {
    failSwitch(error);
    throw error;
  }
}

export async function preflightPostgresTarget(input: EngineTargetInput): Promise<{
  redactedUrl: string;
  preflight: PostgresPreflight;
}> {
  const target = parseEngineTarget(input);
  if (target.engine !== "postgres") {
    throw new EngineSwitchError(
      "PostgreSQL preflight requires a PostgreSQL target.",
      400,
      "INVALID_TARGET",
    );
  }
  return {
    redactedUrl: redactPostgresUrl(target.postgresUrl),
    preflight: await preflightPostgresDatabase(target.postgresUrl),
  };
}

export async function getEngineSelectionStatus() {
  const config = readStorageEngineConfig();
  let postgresMigration: "absent" | "in_progress" | "complete" | "unreachable" =
    "absent";
  let startupError: string | null = null;
  let postgresPreflight: PostgresPreflight | null = null;
  if (config.engine === "postgres") {
    try {
      postgresPreflight = await preflightPostgresDatabase(config.postgresUrl);
      postgresMigration = postgresPreflight.engineMigration;
      if (postgresPreflight.state === "ready") {
        const pool = await createPostgresPool(config.postgresUrl);
        await pool.end();
      } else {
        startupError = postgresPreflight.message;
      }
    } catch (error) {
      postgresMigration = "unreachable";
      startupError =
        error instanceof PostgresSetupError
          ? error.message
          : "PostgreSQL is unavailable.";
    }
  }
  return {
    current: storageEnginePublicStatus(config),
    postgresMigration,
    postgresPreflight,
    startupError,
    job: getEngineSwitchStatus(),
    freshConfirmation: FRESH_SWITCH_CONFIRMATION,
  };
}
