import { beforeEach, describe, expect, it, vi } from "vitest";

const { preflightPostgresTarget, startEngineMigration, switchToEmptyEngine } =
  vi.hoisted(() => ({
  preflightPostgresTarget: vi.fn(),
  startEngineMigration: vi.fn(),
  switchToEmptyEngine: vi.fn(),
  }));

vi.mock("@/lib/storage/engine-switch", () => ({
  EngineSwitchError: class EngineSwitchError extends Error {
    constructor(
      message: string,
      readonly status = 400,
      readonly code = "ENGINE_SWITCH_REJECTED",
    ) {
      super(message);
    }
  },
  getEngineSelectionStatus: vi.fn(),
  preflightPostgresTarget,
  startEngineMigration,
  switchToEmptyEngine,
}));

vi.mock("@/lib/storage/postgres/preflight", () => ({
  PostgresSetupError: class PostgresSetupError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

import { POST } from "./route";
import { PostgresSetupError } from "@/lib/storage/postgres/preflight";

function request(body: unknown, host = "127.0.0.1:3000") {
  return new Request("http://127.0.0.1:3000/api/settings/storage-engine", {
    method: "POST",
    headers: {
      host,
      origin: "http://127.0.0.1:3000",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("storage engine settings API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    startEngineMigration.mockResolvedValue({
      state: "running",
      action: "migrate",
    });
    switchToEmptyEngine.mockResolvedValue({
      state: "completed",
      action: "fresh",
    });
    preflightPostgresTarget.mockResolvedValue({
      redactedUrl: "postgres://user:%E2%80%A2%E2%80%A2@localhost/library",
      preflight: { state: "ready" },
    });
  });

  it("starts the migration path and returns accepted", async () => {
    const response = await POST(
      request({
        action: "migrate",
        engine: "postgres",
        postgresUrl: "postgres://localhost/library",
        postgresSchema: "shared_library",
        postgresTenancy: "schema",
      }),
    );

    expect(response.status).toBe(202);
    expect(startEngineMigration).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "migrate",
        engine: "postgres",
        postgresSchema: "shared_library",
        postgresTenancy: "schema",
      }),
    );
    expect(switchToEmptyEngine).not.toHaveBeenCalled();
  });

  it("keeps fresh switching explicit", async () => {
    const response = await POST(
      request({
        action: "fresh",
        engine: "sqlite",
        sqlitePath: "/tmp/empty.db",
        confirmation: "SWITCH EMPTY",
      }),
    );

    expect(response.status).toBe(202);
    expect(switchToEmptyEngine).toHaveBeenCalledOnce();
    expect(startEngineMigration).not.toHaveBeenCalled();
  });

  it("returns a redacted preflight result and never echoes the password", async () => {
    const response = await POST(
      request({
        action: "preflight",
        engine: "postgres",
        postgresUrl: "postgres://user:very-secret@localhost/library",
      }),
    );
    const body = JSON.stringify(await response.json());

    expect(response.status).toBe(200);
    expect(preflightPostgresTarget).toHaveBeenCalledOnce();
    expect(body).not.toContain("very-secret");
  });

  it("returns classified preflight errors without connection secrets", async () => {
    preflightPostgresTarget.mockRejectedValueOnce(
      new PostgresSetupError(
        "PERMISSION_DENIED",
        "This database account cannot enable search support.",
      ),
    );
    const response = await POST(
      request({
        action: "preflight",
        engine: "postgres",
        postgresUrl: "postgres://user:very-secret@localhost/library",
      }),
    );
    const body = JSON.stringify(await response.json());

    expect(response.status).toBe(503);
    expect(body).toContain("PERMISSION_DENIED");
    expect(body).not.toContain("very-secret");
  });

  it("does not weaken the local mutating guard", async () => {
    const response = await POST(
      request({ action: "migrate", engine: "postgres" }, "example.com"),
    );

    expect(response.status).toBe(403);
    expect(startEngineMigration).not.toHaveBeenCalled();
    expect(switchToEmptyEngine).not.toHaveBeenCalled();
  });

  it("rejects an implicit or unknown action", async () => {
    const response = await POST(request({ engine: "postgres" }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "INVALID_ACTION",
    });
  });
});
