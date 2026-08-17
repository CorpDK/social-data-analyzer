import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "./msw/server";

/**
 * Smoke that MSW is wired for unit tests (HTTP mocks, not Storybook).
 */
describe("MSW providers mock", () => {
  it("intercepts /api/search/providers with the default handler", async () => {
    const res = await fetch("/api/search/providers?library=likes");
    expect(res.ok).toBe(true);
    const body = (await res.json()) as {
      library: string;
      default: string;
      available: string[];
    };
    expect(body.library).toBe("likes");
    expect(body.default).toBe("local");
    expect(body.available).toContain("local");
  });

  it("allows per-test handler overrides", async () => {
    server.use(
      http.get("/api/search/providers", () =>
        HttpResponse.json({
          library: "saves",
          available: ["openai"],
          configured: {
            local: false,
            ollama: false,
            openai: true,
            voyage: false,
          },
          enabled: {
            local: false,
            ollama: false,
            openai: true,
            voyage: false,
          },
          default: "openai",
        }),
      ),
    );

    const res = await fetch("/api/search/providers?library=saves");
    const body = (await res.json()) as { default: string };
    expect(body.default).toBe("openai");
  });
});
