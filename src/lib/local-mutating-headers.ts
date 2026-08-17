import { LOCAL_TOKEN_HEADER } from "@/lib/local-request-guard";

/**
 * Headers to merge into browser fetch() for mutating API calls.
 *
 * When the operator enables token mode, set both:
 * - INSTAGRAM_SAVES_LOCAL_TOKEN (server)
 * - NEXT_PUBLIC_INSTAGRAM_SAVES_LOCAL_TOKEN (same value, client bundle)
 *
 * Cross-origin pages cannot read the public env from our bundle; same-origin
 * UI needs it so Settings / Import / Indexes keep working.
 */
export function localMutatingHeaders(
  init?: HeadersInit,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (init) {
    new Headers(init).forEach((value, key) => {
      out[key] = value;
    });
  }

  const token =
    typeof process !== "undefined"
      ? process.env.NEXT_PUBLIC_INSTAGRAM_SAVES_LOCAL_TOKEN?.trim()
      : undefined;
  if (token) {
    out[LOCAL_TOKEN_HEADER] = token;
  }

  return out;
}
