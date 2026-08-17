/**
 * Finite integer parsing for page / limit query params.
 * Malformed values must fail closed (API → 400), never become NaN SQL.
 */

export type ParseIntParamResult =
  | { ok: true; value: number }
  | { ok: false; error: string };

export type PageParamsResult =
  | { ok: true; page: number; pageSize: number }
  | { ok: false; error: string };

const INT_RE = /^-?\d+$/;

export function parseBoundedIntParam(
  raw: string | null | undefined,
  options: {
    name: string;
    defaultValue: number;
    min: number;
    max: number;
  },
): ParseIntParamResult {
  if (raw == null || raw.trim() === "") {
    return { ok: true, value: options.defaultValue };
  }

  const trimmed = raw.trim();
  if (!INT_RE.test(trimmed)) {
    return {
      ok: false,
      error: `Invalid ${options.name}: must be an integer`,
    };
  }

  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, error: `Invalid ${options.name}` };
  }

  if (n < options.min || n > options.max) {
    return {
      ok: false,
      error: `Invalid ${options.name}: must be between ${options.min} and ${options.max}`,
    };
  }

  return { ok: true, value: n };
}

/** Shared page / pageSize parsing for list routes (saves, likes). */
export function parsePageParams(
  searchParams: URLSearchParams,
  options?: {
    defaultPage?: number;
    defaultPageSize?: number;
    maxPage?: number;
    maxPageSize?: number;
  },
): PageParamsResult {
  const page = parseBoundedIntParam(searchParams.get("page"), {
    name: "page",
    defaultValue: options?.defaultPage ?? 1,
    min: 1,
    max: options?.maxPage ?? 1_000_000,
  });
  if (!page.ok) return page;

  const pageSize = parseBoundedIntParam(searchParams.get("pageSize"), {
    name: "pageSize",
    defaultValue: options?.defaultPageSize ?? 25,
    min: 1,
    max: options?.maxPageSize ?? 100,
  });
  if (!pageSize.ok) return pageSize;

  return { ok: true, page: page.value, pageSize: pageSize.value };
}
