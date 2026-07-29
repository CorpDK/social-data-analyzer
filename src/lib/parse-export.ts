export type MediaType = "post" | "reel" | "igtv" | "unknown";

export type ParsedSavedItem = {
  mediaKey: string;
  href: string;
  shortcode: string | null;
  mediaType: MediaType;
  authorUsername: string | null;
  savedAt: Date | null;
  collections: string[];
};

export type ParseResult = {
  items: ParsedSavedItem[];
  savedJsonFiles: string[];
  warnings: string[];
};

const IG_URL_RE =
  /instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i;

const GENERIC_LABEL_RE =
  /^(saved on|added time|saved post|saved|name|time)$/i;

export function detectMediaType(href: string): MediaType {
  const lower = href.toLowerCase();
  if (lower.includes("/reel/") || lower.includes("/reels/")) return "reel";
  if (lower.includes("/tv/")) return "igtv";
  if (lower.includes("/p/")) return "post";
  return "unknown";
}

export function extractShortcode(href: string): string | null {
  const match = href.match(IG_URL_RE);
  return match?.[1] ?? null;
}

export function mediaKeyFromHref(href: string): string | null {
  const shortcode = extractShortcode(href);
  if (shortcode) return shortcode.toLowerCase();

  try {
    const url = new URL(href);
    const normalized = `${url.hostname}${url.pathname}`.replace(/\/+$/, "");
    return normalized.toLowerCase() || null;
  } catch {
    const cleaned = href.trim().toLowerCase().replace(/\/+$/, "");
    return cleaned || null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readTimestamp(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Instagram exports use seconds; tolerate ms.
    const ms = value > 1e12 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === "string" && value.trim()) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) return readTimestamp(asNumber);
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function looksLikeUsername(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 64) return false;
  if (GENERIC_LABEL_RE.test(trimmed)) return false;
  if (/^https?:\/\//i.test(trimmed)) return false;
  return /^[@a-z0-9._-]+$/i.test(trimmed);
}

function normalizeUsername(value: string): string {
  return value.replace(/^@+/, "").trim();
}

function readStringListData(entry: Record<string, unknown>): {
  href: string | null;
  savedAt: Date | null;
  value: string | null;
} {
  const list =
    (Array.isArray(entry.string_list_data) && entry.string_list_data) ||
    (Array.isArray(entry.stringListData) && entry.stringListData) ||
    null;

  if (!list) {
    return { href: null, savedAt: null, value: null };
  }

  for (const raw of list) {
    const data = asRecord(raw);
    if (!data) continue;
    const href = readString(data.href);
    if (href) {
      return {
        href,
        savedAt: readTimestamp(data.timestamp),
        value: readString(data.value),
      };
    }
  }

  const first = asRecord(list[0]);
  return {
    href: null,
    savedAt: first ? readTimestamp(first.timestamp) : null,
    value: first ? readString(first.value) : null,
  };
}

function readAuthorUsername(
  entry: Record<string, unknown>,
  listValue: string | null = null,
): string | null {
  const title = readString(entry.title);
  if (title) return normalizeUsername(title);

  if (listValue && looksLikeUsername(listValue)) {
    return normalizeUsername(listValue);
  }

  const map = asRecord(entry.string_map_data) ?? asRecord(entry.stringMapData);
  if (map) {
    for (const [key, value] of Object.entries(map)) {
      if (!/name|author|username|channel|creator|profile/i.test(key)) continue;
      const data = asRecord(value);
      const fromValue = readString(data?.value);
      if (fromValue && looksLikeUsername(fromValue)) {
        return normalizeUsername(fromValue);
      }
    }

    const nameField = asRecord(map.Name) ?? asRecord(map.name);
    const fromName = readString(nameField?.value);
    if (fromName && looksLikeUsername(fromName)) {
      return normalizeUsername(fromName);
    }
  }

  return null;
}

function collectHrefs(node: unknown, out: string[] = []): string[] {
  if (!node) return out;
  if (typeof node === "string") {
    if (IG_URL_RE.test(node) || node.includes("instagram.com/")) {
      out.push(node);
    }
    return out;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectHrefs(item, out);
    return out;
  }
  const obj = asRecord(node);
  if (!obj) return out;

  for (const [key, value] of Object.entries(obj)) {
    if (key.toLowerCase() === "href" && typeof value === "string") {
      out.push(value);
    } else {
      collectHrefs(value, out);
    }
  }
  return out;
}

function readSavedOn(entry: Record<string, unknown>): {
  href: string | null;
  savedAt: Date | null;
  value: string | null;
} {
  const map = asRecord(entry.string_map_data) ?? asRecord(entry.stringMapData);
  if (map) {
    for (const [key, value] of Object.entries(map)) {
      if (!/saved|added|time/i.test(key)) continue;
      const data = asRecord(value);
      if (!data) continue;
      const href = readString(data.href);
      if (href) {
        return {
          href,
          savedAt: readTimestamp(data.timestamp),
          value: readString(data.value),
        };
      }
    }

    // Flat collections: Name.href + Added Time.timestamp
    const nameField = asRecord(map.Name) ?? asRecord(map.name);
    const href = readString(nameField?.href);
    if (href) {
      const addedTime =
        asRecord(map["Added Time"]) ??
        asRecord(map["Saved on"]) ??
        asRecord(map.Time);
      return {
        href,
        savedAt: readTimestamp(addedTime?.timestamp),
        value: readString(nameField?.value),
      };
    }

    // Fallback: first map entry with an href
    for (const value of Object.values(map)) {
      const data = asRecord(value);
      if (!data) continue;
      const href = readString(data.href);
      if (href) {
        return {
          href,
          savedAt: readTimestamp(data.timestamp),
          value: readString(data.value),
        };
      }
    }
  }

  return readStringListData(entry);
}

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

function parseSavedMediaArray(
  entries: unknown[],
  items: Map<string, ParsedSavedItem>,
  collection: string | null,
) {
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

export function parseExportJsonFiles(
  files: Array<{ name: string; content: string }>,
): ParseResult {
  const items = new Map<string, ParsedSavedItem>();
  const savedJsonFiles: string[] = [];
  const warnings: string[] = [];

  for (const file of files) {
    if (!shouldParseJsonFile(file.name)) continue;

    if (isSavedJsonFile(file.name)) {
      savedJsonFiles.push(file.name);
    }

    try {
      const json = JSON.parse(file.content) as unknown;
      parseJsonDocument(json, items, file.name);
    } catch {
      warnings.push(`Skipped malformed JSON: ${file.name}`);
    }
  }

  const parsedItems = [...items.values()].sort((a, b) => {
    const at = a.savedAt?.getTime() ?? 0;
    const bt = b.savedAt?.getTime() ?? 0;
    return bt - at;
  });

  return { items: parsedItems, savedJsonFiles, warnings };
}
