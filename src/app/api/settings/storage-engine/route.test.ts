import { beforeEach, describe, expect, it, vi } from "vitest";

const { startEngineMigration, switchToEmptyEngine } = vi.hoisted(() => ({
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
  startEngineMigration,
  switchToEmptyEngine,
}));

import { POST } from "./route";

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
  });

  it("starts the migration path and returns accepted", async () => {
    const response = await POST(
      request({
        action: "migrate",
        engine: "postgres",
        postgresUrl: "postgres://localhost/library",
      }),
    );

    expect(response.status).toBe(202);
    expect(startEngineMigration).toHaveBeenCalledWith(
      expect.objectContaining({ action: "migrate", engine: "postgres" }),
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
