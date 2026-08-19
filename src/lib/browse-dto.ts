/**
 * Lightweight runtime guards for browse / search client payloads.
 * Soft-fail (null) so UI can keep last good state or empty defaults.
 */

import type {
  EmbeddingProvider,
  SearchProviderInfoDto,
} from "@/lib/search/status-dto";

const PROVIDERS: readonly EmbeddingProvider[] = [
  "local",
  "ollama",
  "openai",
  "voyage",
];

export type BrowseFilterOptions = {
  authors: string[];
  collections?: string[];
};

export type BrowseListResponse<TItem> = {
  items: TItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  searchMode?: string;
  searchProvider?: EmbeddingProvider | null;
  providerFallback?: boolean;
  providerFallbackReason?: string;
  totalCapped?: boolean;
  searchCap?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isProvider(value: unknown): value is EmbeddingProvider {
  return (
    typeof value === "string" &&
    (PROVIDERS as readonly string[]).includes(value)
  );
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((entry) => typeof entry === "string")) return null;
  return value;
}

export function parseBrowseFilterOptions(
  value: unknown,
): BrowseFilterOptions | null {
  if (!isRecord(value)) return null;
  const authors = stringArray(value.authors);
  if (!authors) return null;
  if (value.collections === undefined) {
    return { authors };
  }
  const collections = stringArray(value.collections);
  if (!collections) return null;
  return { authors, collections };
}

export function parseSearchProviderInfo(
  value: unknown,
): SearchProviderInfoDto | null {
  if (!isRecord(value)) return null;
  const available = value.available;
  if (!Array.isArray(available) || !available.every(isProvider)) return null;
  if (!isProvider(value.default)) return null;
  if (!isRecord(value.configured)) return null;
  for (const key of PROVIDERS) {
    if (typeof value.configured[key] !== "boolean") return null;
  }
  const configured = value.configured as Record<EmbeddingProvider, boolean>;
  const result: SearchProviderInfoDto = {
    available: available as EmbeddingProvider[],
    configured,
    default: value.default,
  };
  if (value.enabled !== undefined) {
    if (!isRecord(value.enabled)) return null;
    for (const key of PROVIDERS) {
      if (typeof value.enabled[key] !== "boolean") return null;
    }
    result.enabled = value.enabled as Record<EmbeddingProvider, boolean>;
  }
  return result;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Validate browse list envelope; items stay opaque (caller supplies row guard
 * only when needed). Rejects non-array items / non-finite pagination fields.
 */
export function parseBrowseListResponse<TItem = unknown>(
  value: unknown,
): BrowseListResponse<TItem> | null {
  if (!isRecord(value)) return null;
  if (!Array.isArray(value.items)) return null;
  if (
    !isFiniteNumber(value.total) ||
    !isFiniteNumber(value.page) ||
    !isFiniteNumber(value.pageSize) ||
    !isFiniteNumber(value.totalPages)
  ) {
    return null;
  }

  const out: BrowseListResponse<TItem> = {
    items: value.items as TItem[],
    total: value.total,
    page: value.page,
    pageSize: value.pageSize,
    totalPages: value.totalPages,
  };

  if (value.searchMode !== undefined) {
    if (typeof value.searchMode !== "string") return null;
    out.searchMode = value.searchMode;
  }
  if (value.searchProvider !== undefined && value.searchProvider !== null) {
    if (!isProvider(value.searchProvider)) return null;
    out.searchProvider = value.searchProvider;
  } else if (value.searchProvider === null) {
    out.searchProvider = null;
  }
  if (value.providerFallback !== undefined) {
    if (typeof value.providerFallback !== "boolean") return null;
    out.providerFallback = value.providerFallback;
  }
  if (value.providerFallbackReason !== undefined) {
    if (typeof value.providerFallbackReason !== "string") return null;
    out.providerFallbackReason = value.providerFallbackReason;
  }
  if (value.totalCapped !== undefined) {
    if (typeof value.totalCapped !== "boolean") return null;
    out.totalCapped = value.totalCapped;
  }
  if (value.searchCap !== undefined) {
    if (!isFiniteNumber(value.searchCap)) return null;
    out.searchCap = value.searchCap;
  }

  return out;
}
