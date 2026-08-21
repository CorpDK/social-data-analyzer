import { describe, expect, it } from "vitest";
import {
  evaluateLocalMutatingRequest,
  getLocalTokenFromEnv,
  isAllowedLocalHostname,
  LOCAL_TOKEN_ENV,
  LOCAL_TOKEN_HEADER,
} from "./local-request-guard";

function req(
  headers: Record<string, string>,
  init?: { method?: string },
): Request {
  return new Request("http://127.0.0.1:3000/api/settings/keys", {
    method: init?.method ?? "POST",
    headers,
  });
}

describe("isAllowedLocalHostname", () => {
  it("allows loopback names", () => {
    expect(isAllowedLocalHostname("localhost")).toBe(true);
    expect(isAllowedLocalHostname("127.0.0.1")).toBe(true);
    expect(isAllowedLocalHostname("::1")).toBe(true);
    expect(isAllowedLocalHostname("[::1]")).toBe(true);
  });

  it("rejects non-local hosts", () => {
    expect(isAllowedLocalHostname("example.com")).toBe(false);
    expect(isAllowedLocalHostname("192.168.1.10")).toBe(false);
    expect(isAllowedLocalHostname("0.0.0.0")).toBe(false);
  });

  it("allows IPv4-mapped loopback from Node sockets", () => {
    expect(isAllowedLocalHostname("::ffff:127.0.0.1")).toBe(true);
  });
});

describe("evaluateLocalMutatingRequest", () => {
  const noToken: Record<string, string | undefined> = {};

  it("accepts loopback Host without Origin when token unset", () => {
    const result = evaluateLocalMutatingRequest(
      req({ host: "127.0.0.1:3000" }),
      noToken,
    );
    expect(result).toEqual({ ok: true });
  });

  it("accepts localhost Host with matching loopback Origin", () => {
    const result = evaluateLocalMutatingRequest(
      req({
        host: "localhost:3000",
        origin: "http://localhost:3000",
      }),
      noToken,
    );
    expect(result).toEqual({ ok: true });
  });

  it("rejects forged Host", () => {
    const result = evaluateLocalMutatingRequest(
      req({ host: "evil.example" }),
      noToken,
    );
    expect(result).toMatchObject({ ok: false, reason: "bad_host", status: 403 });
  });

  it("rejects missing Host", () => {
    const result = evaluateLocalMutatingRequest(req({}), noToken);
    expect(result).toMatchObject({
      ok: false,
      reason: "missing_host",
      status: 403,
    });
  });

  it("rejects cross-site Origin even with local Host", () => {
    const result = evaluateLocalMutatingRequest(
      req({
        host: "127.0.0.1:3000",
        origin: "https://evil.example",
      }),
      noToken,
    );
    expect(result).toMatchObject({
      ok: false,
      reason: "bad_origin",
      status: 403,
    });
  });

  it("accepts Next.js-injected loopback X-Forwarded-* headers", () => {
    const result = evaluateLocalMutatingRequest(
      req({
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000",
        "x-forwarded-host": "127.0.0.1:3000",
        "x-forwarded-proto": "http",
        "x-forwarded-for": "::1",
      }),
      noToken,
    );
    expect(result).toEqual({ ok: true });
  });

  it("rejects spoofed X-Forwarded-* instead of trusting them", () => {
    const result = evaluateLocalMutatingRequest(
      req({
        host: "127.0.0.1:3000",
        "x-forwarded-host": "evil.example",
      }),
      noToken,
    );
    expect(result).toMatchObject({
      ok: false,
      reason: "forwarded_header",
      status: 403,
    });
  });

  it("rejects non-loopback X-Forwarded-For", () => {
    const result = evaluateLocalMutatingRequest(
      req({
        host: "127.0.0.1:3000",
        "x-forwarded-for": "8.8.8.8",
      }),
      noToken,
    );
    expect(result).toMatchObject({
      ok: false,
      reason: "forwarded_header",
      status: 403,
    });
  });

  it("when token set, requires matching header", () => {
    const env = { [LOCAL_TOKEN_ENV]: "secret-token" };

    expect(
      evaluateLocalMutatingRequest(req({ host: "127.0.0.1:3000" }), env),
    ).toMatchObject({ ok: false, reason: "missing_token" });

    expect(
      evaluateLocalMutatingRequest(
        req({
          host: "127.0.0.1:3000",
          [LOCAL_TOKEN_HEADER]: "wrong",
        }),
        env,
      ),
    ).toMatchObject({ ok: false, reason: "bad_token" });

    expect(
      evaluateLocalMutatingRequest(
        req({
          host: "127.0.0.1:3000",
          [LOCAL_TOKEN_HEADER]: "secret-token",
        }),
        env,
      ),
    ).toEqual({ ok: true });

    expect(
      evaluateLocalMutatingRequest(
        req({
          host: "127.0.0.1:3000",
          authorization: "Bearer secret-token",
        }),
        env,
      ),
    ).toEqual({ ok: true });
  });
});

describe("getLocalTokenFromEnv", () => {
  it("returns null when unset or blank", () => {
    expect(getLocalTokenFromEnv({})).toBeNull();
    expect(getLocalTokenFromEnv({ [LOCAL_TOKEN_ENV]: "  " })).toBeNull();
  });

  it("returns trimmed token", () => {
    expect(getLocalTokenFromEnv({ [LOCAL_TOKEN_ENV]: " abc " })).toBe("abc");
  });
});
