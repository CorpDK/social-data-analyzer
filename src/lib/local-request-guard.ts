import { NextResponse } from "next/server";

/**
 * Local-only trust boundary for mutating API routes (POST / PUT / PATCH / DELETE).
 *
 * Threat model (Option A — loopback Next):
 * - Bind the HTTP server to 127.0.0.1 so LAN peers cannot connect.
 * - Reject non-loopback Host and cross-site Origin on mutations (CSRF / Host spoof).
 * - Do not trust X-Forwarded-* for identity. Next.js injects loopback
 *   X-Forwarded-Host / -Proto / -For on every request (`??=` Host / socket);
 *   allow those only when every value is still loopback. Spoofed non-local
 *   forwarded headers are refused.
 * - Optional INSTAGRAM_SAVES_LOCAL_TOKEN: when set, require a matching header so
 *   hostile same-machine pages cannot mutate without the secret. When unset,
 *   Host + Origin checks alone are enough for the default single-operator setup.
 */

export const LOCAL_TOKEN_ENV = "INSTAGRAM_SAVES_LOCAL_TOKEN";
export const LOCAL_TOKEN_HEADER = "x-instagram-saves-token";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

export type LocalGuardFailureReason =
  | "missing_host"
  | "bad_host"
  | "forwarded_header"
  | "bad_origin"
  | "missing_token"
  | "bad_token";

export type LocalGuardResult =
  | { ok: true }
  | { ok: false; reason: LocalGuardFailureReason; status: 403 };

function stripHostBrackets(host: string): string {
  return host.toLowerCase().replace(/^\[|\]$/g, "");
}

function hostnameFromHostHeader(hostHeader: string): string | null {
  const raw = hostHeader.trim().toLowerCase();
  if (!raw) return null;
  try {
    // Host may be "127.0.0.1:3000" or "[::1]:3000".
    const url = new URL(`http://${raw}`);
    return stripHostBrackets(url.hostname);
  } catch {
    try {
      // x-forwarded-for often uses bare IPv6 ("::1") without brackets.
      const url = new URL(`http://[${raw}]`);
      return stripHostBrackets(url.hostname);
    } catch {
      return null;
    }
  }
}

export function isAllowedLocalHostname(hostname: string): boolean {
  const host = stripHostBrackets(hostname);
  if (LOOPBACK_HOSTNAMES.has(host)) return true;
  // Node may report IPv4-mapped loopback on dual-stack sockets.
  return host === "::ffff:127.0.0.1";
}

export type LocalGuardEnv = Record<string, string | undefined>;

export function getLocalTokenFromEnv(
  env: LocalGuardEnv = process.env,
): string | null {
  const token = env[LOCAL_TOKEN_ENV]?.trim();
  return token ? token : null;
}

function headerValue(request: Request, name: string): string | null {
  const value = request.headers.get(name)?.trim();
  return value ? value : null;
}

function forwardedHeadersAreLocal(request: Request): boolean {
  const forwardedHost = headerValue(request, "x-forwarded-host");
  if (forwardedHost) {
    const hostname = hostnameFromHostHeader(forwardedHost);
    if (!hostname || !isAllowedLocalHostname(hostname)) return false;
  }

  const forwardedFor = headerValue(request, "x-forwarded-for");
  if (forwardedFor) {
    for (const hop of forwardedFor.split(",")) {
      const hostname = hostnameFromHostHeader(hop);
      if (!hostname || !isAllowedLocalHostname(hostname)) return false;
    }
  }

  const forwardedProto = headerValue(request, "x-forwarded-proto");
  if (forwardedProto) {
    const proto = forwardedProto.toLowerCase();
    if (proto !== "http" && proto !== "https") return false;
  }

  return true;
}

function extractProvidedToken(request: Request): string | null {
  const custom = request.headers.get(LOCAL_TOKEN_HEADER)?.trim();
  if (custom) return custom;

  const auth = request.headers.get("authorization")?.trim();
  if (!auth) return null;
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  return match?.[1]?.trim() || null;
}

/**
 * Pure check used by unit tests and the route helper.
 * Does not read process.env except via the optional `env` argument for the token.
 */
export function evaluateLocalMutatingRequest(
  request: Request,
  env: LocalGuardEnv = process.env,
): LocalGuardResult {
  // Next.js always fills loopback X-Forwarded-* ; reject only non-local spoofs.
  if (!forwardedHeadersAreLocal(request)) {
    return { ok: false, reason: "forwarded_header", status: 403 };
  }

  const hostHeader = request.headers.get("host");
  if (!hostHeader?.trim()) {
    return { ok: false, reason: "missing_host", status: 403 };
  }

  const hostname = hostnameFromHostHeader(hostHeader);
  if (!hostname || !isAllowedLocalHostname(hostname)) {
    return { ok: false, reason: "bad_host", status: 403 };
  }

  const origin = request.headers.get("origin")?.trim();
  if (origin) {
    try {
      const originHost = new URL(origin).hostname.replace(/^\[|\]$/g, "");
      if (!isAllowedLocalHostname(originHost)) {
        return { ok: false, reason: "bad_origin", status: 403 };
      }
    } catch {
      return { ok: false, reason: "bad_origin", status: 403 };
    }
  }

  const expected = getLocalTokenFromEnv(env);
  if (expected) {
    const provided = extractProvidedToken(request);
    if (!provided) {
      return { ok: false, reason: "missing_token", status: 403 };
    }
    if (provided !== expected) {
      return { ok: false, reason: "bad_token", status: 403 };
    }
  }

  return { ok: true };
}

const REASON_MESSAGES: Record<LocalGuardFailureReason, string> = {
  missing_host: "Missing Host header",
  bad_host: "Non-local Host rejected",
  forwarded_header: "Forwarded headers are not trusted on this local app",
  bad_origin: "Cross-site Origin rejected",
  missing_token: "Local token required",
  bad_token: "Invalid local token",
};

/** Returns a 403 JSON response when the request fails the local guard; else null. */
export function rejectUnlessLocalMutating(
  request: Request,
  env: LocalGuardEnv = process.env,
): NextResponse | null {
  const result = evaluateLocalMutatingRequest(request, env);
  if (result.ok) return null;
  return NextResponse.json(
    { error: REASON_MESSAGES[result.reason], reason: result.reason },
    { status: result.status },
  );
}
