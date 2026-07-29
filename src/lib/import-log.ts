import type { MediaType } from "./parse-export";

export type ImportLog = {
  filesScanned: number;
  jsonFilesParsed: number;
  savedJsonFiles: string[];
  itemsParsed: number;
  typeCounts: Record<MediaType, number>;
  collectionsFound: string[];
  authorsFound: number;
  itemsWithSavedAt: number;
  warnings: string[];
};

export function emptyImportLog(): ImportLog {
  return {
    filesScanned: 0,
    jsonFilesParsed: 0,
    savedJsonFiles: [],
    itemsParsed: 0,
    typeCounts: { post: 0, reel: 0, igtv: 0, unknown: 0 },
    collectionsFound: [],
    authorsFound: 0,
    itemsWithSavedAt: 0,
    warnings: [],
  };
}

export function serializeImportLog(log: ImportLog): string {
  return JSON.stringify(log);
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
    return {
      ...emptyImportLog(),
      ...parsed,
      typeCounts: {
        ...emptyImportLog().typeCounts,
        ...(parsed.typeCounts ?? {}),
      },
      savedJsonFiles: parsed.savedJsonFiles ?? [],
      collectionsFound: parsed.collectionsFound ?? [],
      warnings: parsed.warnings ?? [],
    };
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

  return {
    filesScanned: files.length,
    jsonFilesParsed: savedJsonFiles.length,
    savedJsonFiles,
    itemsParsed: items.length,
    typeCounts,
    collectionsFound: [...collectionSet].sort((a, b) => a.localeCompare(b)),
    authorsFound,
    itemsWithSavedAt,
    warnings,
  };
}
