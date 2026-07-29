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

const IG_URL_RE =
  /instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i;

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

function readSavedOn(
  entry: Record<string, unknown>,
): { href: string | null; savedAt: Date | null } {
  const map = asRecord(entry.string_map_data) ?? asRecord(entry.stringMapData);
  if (!map) {
    return { href: null, savedAt: null };
  }

  for (const [key, value] of Object.entries(map)) {
    if (!/saved/i.test(key)) continue;
    const data = asRecord(value);
    if (!data) continue;
    return {
      href: readString(data.href),
      savedAt: readTimestamp(data.timestamp),
    };
  }

  // Fallback: first map entry with an href
  for (const value of Object.values(map)) {
    const data = asRecord(value);
    if (!data) continue;
    const href = readString(data.href);
    if (href) {
      return { href, savedAt: readTimestamp(data.timestamp) };
    }
  }

  return { href: null, savedAt: null };
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

    const title = readString(entry.title);
    const { href, savedAt } = readSavedOn(entry);

    if (href) {
      pushItem(items, {
        href,
        authorUsername: title,
        savedAt,
        collection,
      });
      continue;
    }

    for (const found of collectHrefs(entry)) {
      pushItem(items, {
        href: found,
        authorUsername: title,
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
    for (const raw of collections) {
      const entry = asRecord(raw);
      if (entry) parseCollectionEntry(entry, items);
    }
  }

  // Last resort: any Instagram media URLs in the document
  if (!savedMedia && !collections) {
    for (const found of collectHrefs(root)) {
      pushItem(items, { href: found });
    }
  }
}

export function parseExportJsonFiles(
  files: Array<{ name: string; content: string }>,
): ParsedSavedItem[] {
  const items = new Map<string, ParsedSavedItem>();

  for (const file of files) {
    const lower = file.name.toLowerCase();
    const looksRelevant =
      lower.includes("saved") ||
      lower.includes("collection") ||
      lower.endsWith(".json");

    if (!looksRelevant || !lower.endsWith(".json")) continue;
    // Skip huge unrelated dumps unless path suggests saved content
    if (
      !lower.includes("saved") &&
      !lower.includes("collection") &&
      !/(^|\/)(posts?|reels?)\.json$/.test(lower)
    ) {
      continue;
    }

    try {
      const json = JSON.parse(file.content) as unknown;
      parseJsonDocument(json, items, file.name);
    } catch {
      // Ignore malformed JSON files in the archive
    }
  }

  return [...items.values()].sort((a, b) => {
    const at = a.savedAt?.getTime() ?? 0;
    const bt = b.savedAt?.getTime() ?? 0;
    return bt - at;
  });
}
