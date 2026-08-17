import { describe, expect, it } from "vitest";
import {
  baseUrlTrustHint,
  isLoopbackHostname,
  isOfficialOpenAiHostname,
  parseUrlHostname,
} from "./base-url-trust";

describe("base-url-trust", () => {
  it("parses hostnames and detects loopback / OpenAI", () => {
    expect(parseUrlHostname("http://127.0.0.1:11434")).toBe("127.0.0.1");
    expect(parseUrlHostname("not a url")).toBeNull();
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isOfficialOpenAiHostname("api.openai.com")).toBe(true);
    expect(isOfficialOpenAiHostname("evil.example")).toBe(false);
  });

  it("returns soft hints only for unexpected hosts", () => {
    expect(baseUrlTrustHint("http://127.0.0.1:11434", "ollama")).toBeNull();
    expect(baseUrlTrustHint("https://api.openai.com/v1", "openai")).toBeNull();
    expect(baseUrlTrustHint("http://192.168.1.10:11434", "ollama")).toMatch(
      /Non-local Ollama/,
    );
    expect(
      baseUrlTrustHint("https://proxy.example.com/v1", "openai"),
    ).toMatch(/Custom remote base URL/);
  });
});
