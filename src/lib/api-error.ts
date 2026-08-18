import { NextResponse } from "next/server";

/**
 * Stable client-facing API error bodies.
 * Unexpected failures get a generic message + code; details stay in server logs.
 */

export type ApiErrorBody = {
  error: string;
  code: string;
};

export function jsonApiError(
  status: number,
  code: string,
  message: string,
): NextResponse {
  return NextResponse.json(
    { error: message, code } satisfies ApiErrorBody,
    { status },
  );
}

/** Intentional client-visible domain / validation errors. */
export function jsonPublicError(
  status: number,
  code: string,
  message: string,
): NextResponse {
  return jsonApiError(status, code, message);
}

/**
 * Unexpected failures: log the raw error server-side and return a stable
 * code + generic message (never leak exception text by default).
 */
export function jsonInternalError(
  context: string,
  error: unknown,
  options?: {
    code?: string;
    message?: string;
    status?: number;
  },
): NextResponse {
  console.error(context, error);
  return jsonApiError(
    options?.status ?? 500,
    options?.code ?? "INTERNAL_ERROR",
    options?.message ?? "An unexpected error occurred",
  );
}
