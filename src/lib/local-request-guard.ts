import { NextResponse } from "next/server";

/**
 * Local-only trust boundary for mutating API routes (POST / PUT / PATCH / DELETE).
 *
 * Threat model (Option A — loopback Next):
 * - Bind the HTTP server to 127.0.0.1 so LAN peers cannot connect.
 * - Reject non-loopback Host and cross-site Origin on mutations (CSRF / Host spoof).
 * - Do not trust X-Forwarded-* (spoofable); presence on a loopback app is refused.
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

function hostnameFromHostHeader(hostHeader: string): string | null {
  const raw = hostHeader.trim().toLowerCase();
  if (!raw) return null;
  try {
    // Host may be "127.0.0.1:3000" or "[::1]:3000".
    const url = new URL(`http://${raw}`);
    return url.hostname.replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
}

export function isAllowedLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return LOOPBACK_HOSTNAMES.has(host);
}

export type LocalGuardEnv = Record<string, string | undefined>;

export function getLocalTokenFromEnv(
  env: LocalGuardEnv = process.env,
): string | null {
  const token = env[LOCAL_TOKEN_ENV]?.trim();
  return token ? token : null;
}

function headerPresent(request: Request, name: string): boolean {
  const value = request.headers.get(name);
  return value != null && value.trim() !== "";
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
  // Never trust forwarded headers on a loopback-bound local app.
  if (
    headerPresent(request, "x-forwarded-host") ||
    headerPresent(request, "x-forwarded-for") ||
    headerPresent(request, "x-forwarded-proto")
  ) {
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
