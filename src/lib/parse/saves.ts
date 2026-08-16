import {
  detectMediaType,
  extractShortcode,
  mediaKeyFromHref,
  type ParsedSavedItem,
  type ParseResult,
} from "./types";
import {
  asRecord,
  collectHrefs,
  findLabeledValue,
  findTitledDict,
  isLabelValuesEntry,
  looksLikeUsername,
  normalizeUsername,
  readAuthorUsername,
  readHrefFromLabelValues,
  readLabelValuesList,
  readOwnerUsernameFromLabelValues,
  readSavedOn,
  readString,
  readStringListData,
  readTimestamp,
} from "./helpers";

function pushItem(
  items: Map<string, ParsedSavedItem>,
  partial: {
    href: string;
    authorUsername?: string | null;
    savedAt?: Date | null;
    collection?: string | null;
  },
) {
  const mediaKey = mediaKeyFromHref(partial.href);
  if (!mediaKey) return;

  const shortcode = extractShortcode(partial.href);
  const mediaType = detectMediaType(partial.href);
  const existing = items.get(mediaKey);
  const collection = partial.collection?.trim() || null;

  if (existing) {
    if (!existing.authorUsername && partial.authorUsername) {
      existing.authorUsername = partial.authorUsername;
    }
    if (
      partial.savedAt &&
      (!existing.savedAt || partial.savedAt > existing.savedAt)
    ) {
      existing.savedAt = partial.savedAt;
    }
    if (collection && !existing.collections.includes(collection)) {
      existing.collections.push(collection);
    }
    return;
  }

  items.set(mediaKey, {
    mediaKey,
    href: partial.href,
    shortcode,
    mediaType,
    authorUsername: partial.authorUsername ?? null,
    savedAt: partial.savedAt ?? null,
    collections: collection ? [collection] : [],
  });
}

function parseLabelValuesMediaFields(
  labelValues: unknown[],
  items: Map<string, ParsedSavedItem>,
  opts: {
    savedAt?: Date | null;
    collection?: string | null;
  },
) {
  const href = readHrefFromLabelValues(labelValues);
  const authorUsername = readOwnerUsernameFromLabelValues(labelValues);
  if (href) {
    pushItem(items, {
      href,
      authorUsername,
      savedAt: opts.savedAt ?? null,
      collection: opts.collection ?? null,
    });
    return;
  }

  for (const found of collectHrefs(labelValues)) {
    pushItem(items, {
      href: found,
      authorUsername,
      savedAt: opts.savedAt ?? null,
      collection: opts.collection ?? null,
    });
  }
}

function parseLabelValuesEntry(
  entry: Record<string, unknown>,
  items: Map<string, ParsedSavedItem>,
  collection: string | null,
) {
  const labelValues = readLabelValuesList(entry);
  if (!labelValues) return;

  const savedAt =
    readTimestamp(entry.timestamp) ??
    readTimestamp(findLabeledValue(labelValues, "Update time")?.timestamp_value);

  const namedCollection =
    readString(findLabeledValue(labelValues, "Name")?.value) ?? null;
  const collectionName = collection ?? namedCollection;

  const mediaChildren = findTitledDict(labelValues, "Media");
  if (mediaChildren && mediaChildren.length > 0) {
    // Collection document: membership lives under title "Media"
    for (const childRaw of mediaChildren) {
      const child = asRecord(childRaw);
      if (!child) continue;
      const childFields = Array.isArray(child.dict) ? child.dict : null;
      if (childFields) {
        parseLabelValuesMediaFields(childFields, items, {
          // Prefer per-item timestamps when present; else leave unset so
          // saved_posts.json can supply the true saved-at.
          savedAt: null,
          collection: collectionName,
        });
      } else {
        for (const found of collectHrefs(child)) {
          pushItem(items, { href: found, collection: collectionName });
        }
      }
    }
    return;
  }

  // Saved post/reel document (flat label_values with URL + Owner)
  parseLabelValuesMediaFields(labelValues, items, {
    savedAt,
    collection,
  });
}

function parseLabelValuesArray(
  entries: unknown[],
  items: Map<string, ParsedSavedItem>,
  collection: string | null,
) {
  for (const raw of entries) {
    const entry = asRecord(raw);
    if (!entry || !isLabelValuesEntry(entry)) continue;
    parseLabelValuesEntry(entry, items, collection);
  }
}

function parseSavedMediaArray(
  entries: unknown[],
  items: Map<string, ParsedSavedItem>,
  collection: string | null,
) {
  const looksLikeLabelValues = entries.some((raw) => {
    const entry = asRecord(raw);
    return entry ? isLabelValuesEntry(entry) : false;
  });

  if (looksLikeLabelValues) {
    parseLabelValuesArray(entries, items, collection);
    return;
  }

  for (const raw of entries) {
    const entry = asRecord(raw);
    if (!entry) continue;

    const { href, savedAt, value } = readSavedOn(entry);
    const authorUsername = readAuthorUsername(entry, value);

    if (href) {
      pushItem(items, {
        href,
        authorUsername,
        savedAt,
        collection,
      });
      continue;
    }

    for (const found of collectHrefs(entry)) {
      pushItem(items, {
        href: found,
        authorUsername,
        savedAt,
        collection,
      });
    }
  }
}

function parseCollectionEntry(
  entry: Record<string, unknown>,
  items: Map<string, ParsedSavedItem>,
) {
  const collectionName =
    readString(entry.title) ??
    readString(entry.name) ??
    readString(asRecord(entry.string_map_data)?.Name) ??
    "Unnamed collection";

  const mediaList =
    (Array.isArray(entry.media_list_data) && entry.media_list_data) ||
    (Array.isArray(entry.mediaListData) && entry.mediaListData) ||
    (Array.isArray(entry.saved_saved_media) && entry.saved_saved_media) ||
    null;

  if (mediaList) {
    parseSavedMediaArray(mediaList, items, collectionName);
  }

  for (const found of collectHrefs(entry)) {
    pushItem(items, { href: found, collection: collectionName });
  }
}

function isFlatCollectionEntry(entry: Record<string, unknown>): boolean {
  const hasMediaList =
    (Array.isArray(entry.media_list_data) && entry.media_list_data.length > 0) ||
    (Array.isArray(entry.mediaListData) && entry.mediaListData.length > 0) ||
    (Array.isArray(entry.saved_saved_media) && entry.saved_saved_media.length > 0);

  if (hasMediaList) return false;

  const map = asRecord(entry.string_map_data) ?? asRecord(entry.stringMapData);
  if (map?.Name || map?.name) return true;

  const list = readStringListData(entry);
  return Boolean(list.href || list.value);
}

function parseFlatCollectionsArray(
  entries: unknown[],
  items: Map<string, ParsedSavedItem>,
) {
  let currentCollection: string | null = null;

  for (const raw of entries) {
    const entry = asRecord(raw);
    if (!entry) continue;

    const map = asRecord(entry.string_map_data) ?? asRecord(entry.stringMapData);
    if (map) {
      const nameField = asRecord(map.Name) ?? asRecord(map.name);
      const href = readString(nameField?.href);
      const value = readString(nameField?.value);

      if (!href && value) {
        currentCollection = value.trim();
        continue;
      }

      if (href) {
        const addedTime =
          asRecord(map["Added Time"]) ??
          asRecord(map["Saved on"]) ??
          asRecord(map.Time);
        pushItem(items, {
          href,
          authorUsername:
            value && looksLikeUsername(value)
              ? normalizeUsername(value)
              : readAuthorUsername(entry, value),
          savedAt: readTimestamp(addedTime?.timestamp),
          collection: currentCollection,
        });
        continue;
      }
    }

    const { href, savedAt, value } = readSavedOn(entry);

    if (!href && value) {
      currentCollection = value.trim();
      continue;
    }

    if (href) {
      pushItem(items, {
        href,
        authorUsername: readAuthorUsername(entry, value),
        savedAt,
        collection: currentCollection,
      });
      continue;
    }

    for (const found of collectHrefs(entry)) {
      pushItem(items, {
        href: found,
        authorUsername: readAuthorUsername(entry, value),
        savedAt,
        collection: currentCollection,
      });
    }
  }
}

function parseJsonDocument(
  json: unknown,
  items: Map<string, ParsedSavedItem>,
  fileHint: string,
) {
  const root = asRecord(json);
  if (!root) {
    if (Array.isArray(json)) {
      parseSavedMediaArray(json, items, null);
    }
    return;
  }

  const savedMedia =
    (Array.isArray(root.saved_saved_media) && root.saved_saved_media) ||
    (Array.isArray(root.saved_media) && root.saved_media) ||
    (Array.isArray(root.saved_posts) && root.saved_posts) ||
    null;

  if (savedMedia) {
    const collectionHint = /collection/i.test(fileHint)
      ? "From collections file"
      : null;
    parseSavedMediaArray(savedMedia, items, collectionHint);
  }

  const collections =
    (Array.isArray(root.saved_saved_collections) &&
      root.saved_saved_collections) ||
    (Array.isArray(root.saved_collections) && root.saved_collections) ||
    null;

  if (collections) {
    const looksFlat = collections.some((raw) => {
      const entry = asRecord(raw);
      return entry ? isFlatCollectionEntry(entry) : false;
    });

    if (looksFlat) {
      parseFlatCollectionsArray(collections, items);
    } else {
      for (const raw of collections) {
        const entry = asRecord(raw);
        if (entry) parseCollectionEntry(entry, items);
      }
    }
  }

  // Last resort: any Instagram media URLs in the document
  if (!savedMedia && !collections) {
    for (const found of collectHrefs(root)) {
      pushItem(items, { href: found });
    }
  }
}

function shouldParseJsonFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (!lower.endsWith(".json")) return false;
  if (lower.includes("__macosx") || lower.split("/").pop()?.startsWith(".")) {
    return false;
  }

  return (
    lower.includes("saved") ||
    lower.includes("collection") ||
    /(^|\/)(posts?|reels?)\.json$/.test(lower)
  );
}

function isSavedJsonFile(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes("saved") || lower.includes("collection");
}

/** Mutable accumulator for streaming zip extract (parse-and-drop per file). */
export type SavesParseAccumulator = {
  items: Map<string, ParsedSavedItem>;
  savedJsonFiles: string[];
  warnings: string[];
};

export function createSavesParseAccumulator(): SavesParseAccumulator {
  return {
    items: new Map(),
    savedJsonFiles: [],
    warnings: [],
  };
}

/** Parse one JSON file into an accumulator; caller may drop `content` afterward. */
export function accumulateExportJsonFile(
  acc: SavesParseAccumulator,
  file: { name: string; content: string },
): void {
  if (!shouldParseJsonFile(file.name)) return;

  if (isSavedJsonFile(file.name)) {
    acc.savedJsonFiles.push(file.name);
  }

  try {
    const json = JSON.parse(file.content) as unknown;
    parseJsonDocument(json, acc.items, file.name);
  } catch {
    acc.warnings.push(`Skipped malformed JSON: ${file.name}`);
  }
}

export function finalizeSavesParse(acc: SavesParseAccumulator): ParseResult {
  const parsedItems = [...acc.items.values()].sort((a, b) => {
    const at = a.savedAt?.getTime() ?? 0;
    const bt = b.savedAt?.getTime() ?? 0;
    return bt - at;
  });

  return {
    items: parsedItems,
    savedJsonFiles: acc.savedJsonFiles,
    warnings: acc.warnings,
  };
}

export function parseExportJsonFiles(
  files: Array<{ name: string; content: string }>,
): ParseResult {
  const acc = createSavesParseAccumulator();
  for (const file of files) {
    accumulateExportJsonFile(acc, file);
  }
  return finalizeSavesParse(acc);
}
