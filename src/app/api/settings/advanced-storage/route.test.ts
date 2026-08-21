import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAppSetting: vi.fn(),
  setAppSetting: vi.fn(),
}));

vi.mock("@/lib/storage", () => ({
  getStorage: vi.fn(async () => ({
    settings: {
      getAppSetting: mocks.getAppSetting,
      setAppSetting: mocks.setAppSetting,
    },
  })),
}));

import { GET, POST } from "./route";

function request(
  body: unknown,
  extraHeaders: Record<string, string> = {},
) {
  return new Request("http://127.0.0.1:3000/api/settings/advanced-storage", {
    method: "POST",
    headers: {
      host: "127.0.0.1:3000",
      origin: "http://127.0.0.1:3000",
      "content-type": "application/json",
      "x-forwarded-host": "127.0.0.1:3000",
      "x-forwarded-proto": "http",
      "x-forwarded-for": "127.0.0.1",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

describe("advanced storage settings API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAppSetting.mockResolvedValue(null);
    mocks.setAppSetting.mockResolvedValue(undefined);
    delete process.env.INSTAGRAM_SAVES_DATABASE_URL;
  });

  it("returns the stored opt-in flag", async () => {
    mocks.getAppSetting.mockResolvedValue("1");

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      enabled: true,
      lockedByEnvironment: false,
    });
  });

  it("persists the opt-in through the local mutating guard", async () => {
    const response = await POST(request({ enabled: true }));

    expect(response.status).toBe(200);
    expect(mocks.setAppSetting).toHaveBeenCalledWith(
      "postgres_advanced_enabled",
      "1",
    );
    await expect(response.json()).resolves.toEqual({ enabled: true });
  });

  it("does not weaken the local mutating guard", async () => {
    const response = await POST(
      request({ enabled: true }, { host: "example.com" }),
    );

    expect(response.status).toBe(403);
    expect(mocks.setAppSetting).not.toHaveBeenCalled();
  });
});
