import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getLibraryStatus: vi.fn(),
  retryLibraryUpdate: vi.fn(),
  isEngineSwitchRunning: vi.fn(),
}));

vi.mock("@/lib/storage", () => ({
  getLibraryStatus: mocks.getLibraryStatus,
  retryLibraryUpdate: mocks.retryLibraryUpdate,
}));

vi.mock("@/lib/storage/engine-switch", () => ({
  isEngineSwitchRunning: mocks.isEngineSwitchRunning,
  engineSwitchBusyMessage: () =>
    "Cannot update the library while a storage engine migration is running.",
}));

import { GET, POST } from "./route";

const ready = {
  engine: "sqlite",
  displayName: "SQLite",
  location: "/tmp/library.db",
  locationFolder: "/tmp",
  state: "up_to_date",
  appliedMigrations: 1,
  pendingMigrations: 0,
};

function request(host = "127.0.0.1:3000") {
  return new Request("http://127.0.0.1:3000/api/settings/library-status", {
    method: "POST",
    headers: {
      host,
      origin: "http://127.0.0.1:3000",
    },
  });
}

describe("library status API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getLibraryStatus.mockResolvedValue(ready);
    mocks.retryLibraryUpdate.mockResolvedValue(ready);
    mocks.isEngineSwitchRunning.mockReturnValue(false);
  });

  it("returns the classified status", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      state: "up_to_date",
      displayName: "SQLite",
    });
  });

  it("retries through the guarded update path", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.retryLibraryUpdate).toHaveBeenCalledOnce();
  });

  it("refuses retry while an engine switch is running", async () => {
    mocks.isEngineSwitchRunning.mockReturnValue(true);

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "LIBRARY_BUSY",
    });
    expect(mocks.retryLibraryUpdate).not.toHaveBeenCalled();
  });

  it("does not weaken the local mutating guard", async () => {
    const response = await POST(request("example.com"));

    expect(response.status).toBe(403);
    expect(mocks.retryLibraryUpdate).not.toHaveBeenCalled();
  });
});
