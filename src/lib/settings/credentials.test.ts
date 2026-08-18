import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const setAppSetting = vi.fn();
const setProviderLibraryEnabled = vi.fn();
const setKeyringSecret = vi.fn();
const deleteKeyringSecret = vi.fn();
const getKeyringStatus = vi.fn(() => ({
  available: true,
  backend: "memory" as const,
  message: null,
}));

vi.mock("./app-settings", () => ({
  getEmbeddingTimeoutMs: () => 30_000,
  getOllamaSettings: () => ({
    enabled: { saves: false, likes: false },
    baseUrl: "http://127.0.0.1:11434",
    model: "nomic-embed-text",
  }),
  getOpenAiSettings: () => ({
    enabled: { saves: false, likes: false },
    baseUrl: "https://api.openai.com/v1",
    model: "text-embedding-3-small",
  }),
  getPreferredEmbeddingProvider: () => null,
  getProviderLibraryEnables: () => ({ saves: true, likes: true }),
  getVoyageSettings: () => ({
    enabled: { saves: false, likes: false },
    model: "voyage-3",
  }),
  setAppSetting: (...args: unknown[]) => setAppSetting(...args),
  setProviderLibraryEnabled: (...args: unknown[]) =>
    setProviderLibraryEnabled(...args),
}));

vi.mock("./keyring", () => ({
  deleteKeyringSecret: (...args: unknown[]) => deleteKeyringSecret(...args),
  getKeyringSecret: () => null,
  getKeyringStatus: () => getKeyringStatus(),
  setKeyringSecret: (...args: unknown[]) => setKeyringSecret(...args),
}));

describe("settings validate-then-commit", () => {
  beforeEach(() => {
    setAppSetting.mockClear();
    setProviderLibraryEnabled.mockClear();
    setKeyringSecret.mockClear();
    deleteKeyringSecret.mockClear();
    getKeyringStatus.mockReturnValue({
      available: true,
      backend: "memory",
      message: null,
    });
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("rejects invalid preferredProvider without writing", async () => {
    const { updateSettingsKeys } = await import("./credentials");
    expect(() =>
      updateSettingsKeys({
        openaiApiKey: "sk-test",
        preferredProvider: "not-a-provider" as "openai",
      }),
    ).toThrow(/preferredProvider/);
    expect(setKeyringSecret).not.toHaveBeenCalled();
    expect(setAppSetting).not.toHaveBeenCalled();
  });

  it("rejects invalid timeoutMs without writing secrets or settings", async () => {
    const { updateSettingsKeys } = await import("./credentials");
    expect(() =>
      updateSettingsKeys({
        voyageApiKey: "voyage-test",
        timeoutMs: -1,
      }),
    ).toThrow(/timeoutMs/);
    expect(setKeyringSecret).not.toHaveBeenCalled();
    expect(setAppSetting).not.toHaveBeenCalled();
  });

  it("commits secrets and settings only after full validation", async () => {
    const { updateSettingsKeys } = await import("./credentials");
    updateSettingsKeys({
      openaiApiKey: "sk-ok",
      preferredProvider: "openai",
      timeoutMs: 12_000,
      localEnabled: { saves: true, likes: false },
    });
    expect(setKeyringSecret).toHaveBeenCalledWith("openai", "sk-ok");
    expect(setAppSetting).toHaveBeenCalledWith("embedding_provider", "openai");
    expect(setAppSetting).toHaveBeenCalledWith(
      "embedding_timeout_ms",
      "12000",
    );
    expect(setProviderLibraryEnabled).toHaveBeenCalledWith(
      "local",
      "saves",
      true,
    );
    expect(setProviderLibraryEnabled).toHaveBeenCalledWith(
      "local",
      "likes",
      false,
    );
  });
});
