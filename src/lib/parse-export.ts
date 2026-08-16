export type MediaType = "post" | "reel" | "igtv" | "unknown";

/** Liked items may include stories and comments in addition to feed media. */
export type LikedMediaType =
  | "post"
  | "reel"
  | "igtv"
  | "story"
  | "comment"
  | "unknown";

export type ParsedSavedItem = {
  mediaKey: string;
  href: string;
  shortcode: string | null;
  mediaType: MediaType;
  authorUsername: string | null;
  savedAt: Date | null;
  collections: string[];
};

export type LikedSource =
  | "liked_posts"
  | "story_likes"
  | "liked_comments";

export type ParsedLikedItem = {
  mediaKey: string;
  href: string;
  shortcode: string | null;
  mediaType: LikedMediaType;
  authorUsername: string | null;
  likedAt: Date | null;
  source: LikedSource;
};

export type ParseResult = {
  items: ParsedSavedItem[];
  savedJsonFiles: string[];
  warnings: string[];
};

export type LikesParseResult = {
  items: ParsedLikedItem[];
  likedJsonFiles: string[];
  warnings: string[];
};

const IG_URL_RE =
  /instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i;

/** e.g. /stories/username/1234567890/ or /stories/username/ */
const STORY_URL_RE =
  /instagram\.com\/stories\/([A-Za-z0-9._]+)(?:\/([0-9]+))?/i;

const GENERIC_LABEL_RE =
  /^(saved on|added time|saved post|saved|name|time|liked on|like)$/i;

export function detectMediaType(href: string): MediaType {
  const lower = href.toLowerCase();
  if (lower.includes("/reel/") || lower.includes("/reels/")) return "reel";
  if (lower.includes("/tv/")) return "igtv";
  if (lower.includes("/p/")) return "post";
  return "unknown";
}

export function detectLikedMediaType(
  href: string,
  source: LikedSource,
): LikedMediaType {
  if (source === "liked_comments") return "comment";
  if (source === "story_likes" || /\/stories\//i.test(href)) return "story";
  return detectMediaType(href);
}

export function extractShortcode(href: string): string | null {
  const match = href.match(IG_URL_RE);
  return match?.[1] ?? null;
}

export function extractStoryParts(
  href: string,
): { username: string; storyId: string | null } | null {
  const match = href.match(STORY_URL_RE);
  if (!match?.[1]) return null;
  return {
    username: match[1].toLowerCase(),
    storyId: match[2] ?? null,
  };
}

export function mediaKeyFromHref(href: string): string | null {
  const shortcode = extractShortcode(href);
  if (shortcode) return shortcode.toLowerCase();

  const story = extractStoryParts(href);
  if (story) {
    return story.storyId
      ? `story:${story.username}:${story.storyId}`
      : `story:${story.username}:${href.trim().toLowerCase().replace(/\/+$/, "")}`;
  }

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

function readLabelValuesList(entry: Record<string, unknown>): unknown[] | null {
  if (Array.isArray(entry.label_values)) return entry.label_values;
  if (Array.isArray(entry.labelValues)) return entry.labelValues;
  return null;
}

function isLabelValuesEntry(entry: Record<string, unknown>): boolean {
  return Boolean(readLabelValuesList(entry));
}

function findLabeledValue(
  labelValues: unknown[],
  label: string,
): Record<string, unknown> | null {
  const wanted = label.toLowerCase();
  for (const raw of labelValues) {
    const lv = asRecord(raw);
    if (!lv) continue;
    const name = readString(lv.label);
    if (name && name.toLowerCase() === wanted) return lv;
  }
  return null;
}

function findTitledDict(
  labelValues: unknown[],
  title: string,
): unknown[] | null {
  const wanted = title.toLowerCase();
  for (const raw of labelValues) {
    const lv = asRecord(raw);
    if (!lv) continue;
    const name = readString(lv.title);
    if (name && name.toLowerCase() === wanted) {
      return Array.isArray(lv.dict) ? lv.dict : [];
    }
  }
  return null;
}

function readOwnerUsernameFromLabelValues(
  labelValues: unknown[],
): string | null {
  const ownerPeople = findTitledDict(labelValues, "Owner");
  if (!ownerPeople) return null;

  for (const personRaw of ownerPeople) {
    const person = asRecord(personRaw);
    if (!person) continue;
    const fields = Array.isArray(person.dict) ? person.dict : [];
    for (const fieldRaw of fields) {
      const field = asRecord(fieldRaw);
      if (!field) continue;
      const label = readString(field.label);
      if (!label || !/^username$/i.test(label)) continue;
      const value = readString(field.value);
      if (value && looksLikeUsername(value)) {
        return normalizeUsername(value);
      }
    }
  }

  // Fallback: display Name under Owner when Username is absent
  for (const personRaw of ownerPeople) {
    const person = asRecord(personRaw);
    if (!person) continue;
    const fields = Array.isArray(person.dict) ? person.dict : [];
    for (const fieldRaw of fields) {
      const field = asRecord(fieldRaw);
      if (!field) continue;
      const label = readString(field.label);
      if (!label || !/^name$/i.test(label)) continue;
      const value = readString(field.value);
      if (value && looksLikeUsername(value)) {
        return normalizeUsername(value);
      }
    }
  }

  return null;
}

function readHrefFromLabelValues(labelValues: unknown[]): string | null {
  const urlField = findLabeledValue(labelValues, "URL");
  if (!urlField) return null;
  return readString(urlField.href) ?? readString(urlField.value);
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

function likedSourceFromPath(name: string): LikedSource | null {
  const lower = name.toLowerCase();
  if (lower.includes("liked_comments") || lower.includes("comment_likes")) {
    return "liked_comments";
  }
  if (lower.includes("story_likes") || lower.includes("stories_likes")) {
    return "story_likes";
  }
  if (
    lower.includes("liked_posts") ||
    lower.includes("liked_post") ||
    lower.includes("likes_media_likes") ||
    /\/likes\/[^/]+\.json$/.test(lower)
  ) {
    return "liked_posts";
  }
  return null;
}

function shouldParseLikedJsonFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (!lower.endsWith(".json")) return false;
  if (lower.includes("__macosx") || lower.split("/").pop()?.startsWith(".")) {
    return false;
  }
  return likedSourceFromPath(name) !== null;
}

function pushLikedItem(
  items: Map<string, ParsedLikedItem>,
  partial: {
    href: string;
    authorUsername?: string | null;
    likedAt?: Date | null;
    source: LikedSource;
    mediaKeyOverride?: string | null;
  },
) {
  const baseKey = mediaKeyFromHref(partial.href);
  if (!baseKey && !partial.mediaKeyOverride) return;

  const mediaType = detectLikedMediaType(partial.href, partial.source);
  const shortcode = extractShortcode(partial.href);
  const mediaKey =
    partial.mediaKeyOverride?.trim().toLowerCase() ||
    (partial.source === "liked_comments"
      ? `comment:${baseKey}:${(partial.authorUsername ?? "unknown").toLowerCase()}`
      : baseKey!);

  const existing = items.get(mediaKey);
  if (existing) {
    if (!existing.authorUsername && partial.authorUsername) {
      existing.authorUsername = partial.authorUsername;
    }
    if (
      partial.likedAt &&
      (!existing.likedAt || partial.likedAt > existing.likedAt)
    ) {
      existing.likedAt = partial.likedAt;
    }
    return;
  }

  items.set(mediaKey, {
    mediaKey,
    href: partial.href,
    shortcode,
    mediaType,
    authorUsername: partial.authorUsername ?? null,
    likedAt: partial.likedAt ?? null,
    source: partial.source,
  });
}

function authorFromStoryHref(href: string): string | null {
  const story = extractStoryParts(href);
  return story?.username ?? null;
}

function parseLikedLabelValuesEntry(
  entry: Record<string, unknown>,
  items: Map<string, ParsedLikedItem>,
  source: LikedSource,
) {
  const labelValues = readLabelValuesList(entry);
  if (!labelValues) return;

  const likedAt =
    readTimestamp(entry.timestamp) ??
    readTimestamp(findLabeledValue(labelValues, "Update time")?.timestamp_value) ??
    readTimestamp(findLabeledValue(labelValues, "Liked on")?.timestamp);

  const href = readHrefFromLabelValues(labelValues);
  const authorUsername =
    readOwnerUsernameFromLabelValues(labelValues) ??
    (href ? authorFromStoryHref(href) : null);

  if (href) {
    pushLikedItem(items, {
      href,
      authorUsername,
      likedAt,
      source,
    });
    return;
  }

  for (const found of collectHrefs(labelValues)) {
    pushLikedItem(items, {
      href: found,
      authorUsername:
        authorUsername ?? authorFromStoryHref(found),
      likedAt,
      source,
    });
  }
}

function parseLikedStringListEntry(
  entry: Record<string, unknown>,
  items: Map<string, ParsedLikedItem>,
  source: LikedSource,
) {
  const { href, savedAt: likedAt, value } = readStringListData(entry);
  const authorUsername =
    readAuthorUsername(entry, value) ??
    (href ? authorFromStoryHref(href) : null);

  if (href) {
    pushLikedItem(items, {
      href,
      authorUsername,
      likedAt,
      source,
    });
    return;
  }

  for (const found of collectHrefs(entry)) {
    pushLikedItem(items, {
      href: found,
      authorUsername:
        authorUsername ?? authorFromStoryHref(found),
      likedAt,
      source,
    });
  }
}

function parseLikedMediaArray(
  entries: unknown[],
  items: Map<string, ParsedLikedItem>,
  source: LikedSource,
) {
  const looksLikeLabelValues = entries.some((raw) => {
    const entry = asRecord(raw);
    return entry ? isLabelValuesEntry(entry) : false;
  });

  if (looksLikeLabelValues) {
    for (const raw of entries) {
      const entry = asRecord(raw);
      if (!entry || !isLabelValuesEntry(entry)) continue;
      parseLikedLabelValuesEntry(entry, items, source);
    }
    return;
  }

  for (const raw of entries) {
    const entry = asRecord(raw);
    if (!entry) continue;
    parseLikedStringListEntry(entry, items, source);
  }
}

function parseLikedJsonDocument(
  json: unknown,
  items: Map<string, ParsedLikedItem>,
  source: LikedSource,
) {
  if (Array.isArray(json)) {
    parseLikedMediaArray(json, items, source);
    return;
  }

  const root = asRecord(json);
  if (!root) return;

  const buckets: Array<{ key: string; forcedSource?: LikedSource }> = [
    { key: "likes_media_likes", forcedSource: "liked_posts" },
    { key: "likes_comment_likes", forcedSource: "liked_comments" },
    { key: "story_activities_story_likes", forcedSource: "story_likes" },
    { key: "liked_posts", forcedSource: "liked_posts" },
    { key: "liked_comments", forcedSource: "liked_comments" },
  ];

  let foundBucket = false;
  for (const bucket of buckets) {
    const list = root[bucket.key];
    if (!Array.isArray(list)) continue;
    foundBucket = true;
    parseLikedMediaArray(list, items, bucket.forcedSource ?? source);
  }

  if (!foundBucket) {
    for (const found of collectHrefs(root)) {
      pushLikedItem(items, {
        href: found,
        authorUsername: authorFromStoryHref(found),
        source,
      });
    }
  }
}

/** Mutable accumulator for streaming likes parse (parse-and-drop per file). */
export type LikesParseAccumulator = {
  items: Map<string, ParsedLikedItem>;
  likedJsonFiles: string[];
  warnings: string[];
};

export function createLikesParseAccumulator(): LikesParseAccumulator {
  return {
    items: new Map(),
    likedJsonFiles: [],
    warnings: [],
  };
}

export function accumulateLikedExportJsonFile(
  acc: LikesParseAccumulator,
  file: { name: string; content: string },
): void {
  if (!shouldParseLikedJsonFile(file.name)) return;
  const source = likedSourceFromPath(file.name);
  if (!source) return;

  acc.likedJsonFiles.push(file.name);

  try {
    const json = JSON.parse(file.content) as unknown;
    parseLikedJsonDocument(json, acc.items, source);
  } catch {
    acc.warnings.push(`Skipped malformed likes JSON: ${file.name}`);
  }
}

export function finalizeLikesParse(acc: LikesParseAccumulator): LikesParseResult {
  const parsedItems = [...acc.items.values()].sort((a, b) => {
    const at = a.likedAt?.getTime() ?? 0;
    const bt = b.likedAt?.getTime() ?? 0;
    return bt - at;
  });

  return {
    items: parsedItems,
    likedJsonFiles: acc.likedJsonFiles,
    warnings: acc.warnings,
  };
}

/**
 * Parse Instagram likes export files:
 * - `your_instagram_activity/likes/liked_posts.json` (posts + reels)
 * - `your_instagram_activity/likes/liked_comments.json`
 * - `your_instagram_activity/story_interactions/story_likes.json`
 *
 * Dedupes by media key (URL shortcode / story id / comment composite key).
 */
export function parseLikedExportJsonFiles(
  files: Array<{ name: string; content: string }>,
): LikesParseResult {
  const acc = createLikesParseAccumulator();
  for (const file of files) {
    accumulateLikedExportJsonFile(acc, file);
  }
  return finalizeLikesParse(acc);
}
