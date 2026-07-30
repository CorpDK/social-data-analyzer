import type { LikedMediaType, MediaType } from "./parse-export";

export type ImportLog = {
  filesScanned: number;
  jsonFilesParsed: number;
  savedJsonFiles: string[];
  likedJsonFiles: string[];
  itemsParsed: number;
  likesParsed: number;
  typeCounts: Record<MediaType, number>;
  likeTypeCounts: Record<LikedMediaType, number>;
  collectionsFound: string[];
  /** Saved items that had an author username (not unique authors). */
  authorsFound: number;
  /** Liked items that had an author username (not unique authors). */
  likesAuthorsFound: number;
  itemsWithSavedAt: number;
  likesWithLikedAt: number;
  /** Write outcomes from this import run (persisted after upsert). */
  likesAdded: number;
  likesUpdated: number;
  likesSkipped: number;
  warnings: string[];
};

export function emptyImportLog(): ImportLog {
  return {
    filesScanned: 0,
    jsonFilesParsed: 0,
    savedJsonFiles: [],
    likedJsonFiles: [],
    itemsParsed: 0,
    likesParsed: 0,
    typeCounts: { post: 0, reel: 0, igtv: 0, unknown: 0 },
    likeTypeCounts: {
      post: 0,
      reel: 0,
      igtv: 0,
      story: 0,
      comment: 0,
      unknown: 0,
    },
    collectionsFound: [],
    authorsFound: 0,
    likesAuthorsFound: 0,
    itemsWithSavedAt: 0,
    likesWithLikedAt: 0,
    likesAdded: 0,
    likesUpdated: 0,
    likesSkipped: 0,
    warnings: [],
  };
}

export function serializeImportLog(log: ImportLog): string {
  return JSON.stringify(log);
}

const LIKES_WRITE_WARNING_RE =
  /^Likes:\s*(\d+)\s+added,\s*(\d+)\s+updated,\s*(\d+)\s+unchanged\.?$/i;

/** Recover likes write counts from older logs that only stored them in warnings. */
export function resolveLikesWriteMetrics(log: ImportLog): {
  added: number;
  updated: number;
  skipped: number;
} {
  if (
    log.likesAdded > 0 ||
    log.likesUpdated > 0 ||
    log.likesSkipped > 0 ||
    (log.likesParsed > 0 &&
      log.likesAdded + log.likesUpdated + log.likesSkipped === log.likesParsed)
  ) {
    return {
      added: log.likesAdded,
      updated: log.likesUpdated,
      skipped: log.likesSkipped,
    };
  }

  for (const warning of log.warnings) {
    const match = warning.match(LIKES_WRITE_WARNING_RE);
    if (!match) continue;
    return {
      added: Number(match[1]),
      updated: Number(match[2]),
      skipped: Number(match[3]),
    };
  }

  return {
    added: log.likesAdded,
    updated: log.likesUpdated,
    skipped: log.likesSkipped,
  };
}

/**
 * Older logs folded likes into authorsFound. Prefer explicit likesAuthorsFound;
 * otherwise subtract likes-with-author estimate when the sum looks inflated.
 */
export function resolveAuthorMetrics(log: ImportLog): {
  savesWithAuthor: number;
  likesWithAuthor: number;
} {
  if (log.likesAuthorsFound > 0 || log.likesParsed === 0) {
    return {
      savesWithAuthor: log.authorsFound,
      likesWithAuthor: log.likesAuthorsFound,
    };
  }

  // Legacy: authorsFound counted saves+likes items with an author.
  if (
    log.likesParsed > 0 &&
    log.authorsFound > log.itemsParsed &&
    log.authorsFound >= log.likesWithLikedAt
  ) {
    const likesWithAuthor = Math.min(log.likesWithLikedAt, log.authorsFound);
    return {
      savesWithAuthor: Math.max(0, log.authorsFound - likesWithAuthor),
      likesWithAuthor,
    };
  }

  return {
    savesWithAuthor: log.authorsFound,
    likesWithAuthor: 0,
  };
}

export function parseImportLog(notes: string | null | undefined): ImportLog | null {
  if (!notes?.trim()) return null;
  try {
    const parsed = JSON.parse(notes) as Partial<ImportLog>;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.filesScanned !== "number"
    ) {
      return null;
    }
    const base = {
      ...emptyImportLog(),
      ...parsed,
      typeCounts: {
        ...emptyImportLog().typeCounts,
        ...(parsed.typeCounts ?? {}),
      },
      likeTypeCounts: {
        ...emptyImportLog().likeTypeCounts,
        ...(parsed.likeTypeCounts ?? {}),
      },
      savedJsonFiles: parsed.savedJsonFiles ?? [],
      likedJsonFiles: parsed.likedJsonFiles ?? [],
      collectionsFound: parsed.collectionsFound ?? [],
      warnings: parsed.warnings ?? [],
      likesParsed: parsed.likesParsed ?? 0,
      likesWithLikedAt: parsed.likesWithLikedAt ?? 0,
      likesAuthorsFound: parsed.likesAuthorsFound ?? 0,
      likesAdded: parsed.likesAdded ?? 0,
      likesUpdated: parsed.likesUpdated ?? 0,
      likesSkipped: parsed.likesSkipped ?? 0,
    };

    // Backfill write metrics from legacy warning text when structured fields absent.
    if (
      base.likesParsed > 0 &&
      base.likesAdded === 0 &&
      base.likesUpdated === 0 &&
      base.likesSkipped === 0
    ) {
      const recovered = resolveLikesWriteMetrics(base);
      base.likesAdded = recovered.added;
      base.likesUpdated = recovered.updated;
      base.likesSkipped = recovered.skipped;
    }

    return base;
  } catch {
    return null;
  }
}

export function buildImportLogFromItems(
  files: Array<{ name: string }>,
  savedJsonFiles: string[],
  items: Array<{
    mediaType: MediaType;
    authorUsername: string | null;
    savedAt: Date | null;
    collections: string[];
  }>,
  warnings: string[] = [],
  likes?: {
    likedJsonFiles: string[];
    items: Array<{
      mediaType: LikedMediaType;
      authorUsername: string | null;
      likedAt: Date | null;
    }>;
    warnings?: string[];
  },
): ImportLog {
  const typeCounts: Record<MediaType, number> = {
    post: 0,
    reel: 0,
    igtv: 0,
    unknown: 0,
  };
  const collectionSet = new Set<string>();
  let authorsFound = 0;
  let itemsWithSavedAt = 0;

  for (const item of items) {
    typeCounts[item.mediaType] += 1;
    if (item.authorUsername) authorsFound += 1;
    if (item.savedAt) itemsWithSavedAt += 1;
    for (const name of item.collections) {
      if (name.trim()) collectionSet.add(name.trim());
    }
  }

  const likeTypeCounts: Record<LikedMediaType, number> = {
    post: 0,
    reel: 0,
    igtv: 0,
    story: 0,
    comment: 0,
    unknown: 0,
  };
  let likesAuthorsFound = 0;
  let likesWithLikedAt = 0;
  const likedItems = likes?.items ?? [];
  for (const item of likedItems) {
    likeTypeCounts[item.mediaType] += 1;
    if (item.authorUsername) likesAuthorsFound += 1;
    if (item.likedAt) likesWithLikedAt += 1;
  }

  const likedJsonFiles = likes?.likedJsonFiles ?? [];
  const allWarnings = [...warnings, ...(likes?.warnings ?? [])];

  return {
    filesScanned: files.length,
    jsonFilesParsed: savedJsonFiles.length + likedJsonFiles.length,
    savedJsonFiles,
    likedJsonFiles,
    itemsParsed: items.length,
    likesParsed: likedItems.length,
    typeCounts,
    likeTypeCounts,
    collectionsFound: [...collectionSet].sort((a, b) => a.localeCompare(b)),
    authorsFound,
    likesAuthorsFound,
    itemsWithSavedAt,
    likesWithLikedAt,
    likesAdded: 0,
    likesUpdated: 0,
    likesSkipped: 0,
    warnings: allWarnings,
  };
}
