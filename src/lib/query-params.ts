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

/** Browse filter string / enum bounds (saves + likes list routes). */
export const BROWSE_FILTER_BOUNDS = {
  qMaxLen: 500,
  authorMaxLen: 100,
  collectionMaxLen: 200,
  providerMaxLen: 32,
} as const;

const SAVES_MEDIA_TYPES = new Set([
  "all",
  "post",
  "reel",
  "igtv",
  "unknown",
]);

const LIKES_MEDIA_TYPES = new Set([
  "all",
  "post",
  "reel",
  "igtv",
  "story",
  "comment",
  "unknown",
]);

export type BrowseFilterParamsResult =
  | {
      ok: true;
      q?: string;
      type?: string;
      author?: string;
      collection?: string;
      provider?: string;
    }
  | { ok: false; error: string };

type ParseStringParamResult =
  | { ok: true; value: string | undefined }
  | { ok: false; error: string };

function parseBoundedStringParam(
  raw: string | null | undefined,
  options: { name: string; maxLen: number },
): ParseStringParamResult {
  if (raw == null) return { ok: true, value: undefined };
  if (raw.length > options.maxLen) {
    return {
      ok: false,
      error: `Invalid ${options.name}: must be at most ${options.maxLen} characters`,
    };
  }
  const trimmed = raw.trim();
  return { ok: true, value: trimmed === "" ? undefined : trimmed };
}

function parseMediaTypeParam(
  raw: string | null | undefined,
  allowed: Set<string>,
): ParseStringParamResult {
  if (raw == null || raw.trim() === "") {
    return { ok: true, value: undefined };
  }
  const trimmed = raw.trim().toLowerCase();
  if (!allowed.has(trimmed)) {
    return {
      ok: false,
      error: `Invalid type: must be one of ${[...allowed].join(", ")}`,
    };
  }
  return { ok: true, value: trimmed };
}

/** Shared filter parsing for GET /api/saves and GET /api/likes. */
export function parseBrowseFilterParams(
  searchParams: URLSearchParams,
  options: { library: "saves" | "likes" },
): BrowseFilterParamsResult {
  const q = parseBoundedStringParam(searchParams.get("q"), {
    name: "q",
    maxLen: BROWSE_FILTER_BOUNDS.qMaxLen,
  });
  if (!q.ok) return q;

  const author = parseBoundedStringParam(searchParams.get("author"), {
    name: "author",
    maxLen: BROWSE_FILTER_BOUNDS.authorMaxLen,
  });
  if (!author.ok) return author;

  const collection =
    options.library === "saves"
      ? parseBoundedStringParam(searchParams.get("collection"), {
          name: "collection",
          maxLen: BROWSE_FILTER_BOUNDS.collectionMaxLen,
        })
      : ({ ok: true, value: undefined } as const);
  if (!collection.ok) return collection;

  const type = parseMediaTypeParam(
    searchParams.get("type"),
    options.library === "saves" ? SAVES_MEDIA_TYPES : LIKES_MEDIA_TYPES,
  );
  if (!type.ok) return type;

  const provider = parseBoundedStringParam(searchParams.get("provider"), {
    name: "provider",
    maxLen: BROWSE_FILTER_BOUNDS.providerMaxLen,
  });
  if (!provider.ok) return provider;

  return {
    ok: true,
    q: q.value,
    type: type.value,
    author: author.value,
    collection: collection.value,
    provider: provider.value,
  };
}

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
