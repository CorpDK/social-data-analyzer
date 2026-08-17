import {
  detectLikedMediaType,
  extractCommentIdFromHref,
  extractShortcode,
  extractStoryParts,
  likedCommentMediaKey,
  mediaKeyFromHref,
  type LikedSource,
  type LikesParseResult,
  type ParsedLikedItem,
} from "./types";
import {
  asRecord,
  collectHrefs,
  findLabeledValue,
  isLabelValuesEntry,
  readAuthorUsername,
  readHrefFromLabelValues,
  readLabelValuesList,
  readOwnerUsernameFromLabelValues,
  readString,
  readStringListData,
  readTimestamp,
} from "./helpers";

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
    fbid?: string | null;
    content?: string | null;
  },
) {
  const baseKey = mediaKeyFromHref(partial.href);
  if (!baseKey && !partial.mediaKeyOverride) return;

  const mediaType = detectLikedMediaType(partial.href, partial.source);
  const shortcode = extractShortcode(partial.href);
  const override = partial.mediaKeyOverride?.trim() || null;
  const mediaKey =
    override ||
    (partial.source === "liked_comments"
      ? likedCommentMediaKey({
          baseKey: baseKey!,
          authorUsername: partial.authorUsername,
          likedAt: partial.likedAt,
          fbid: partial.fbid,
          commentId: extractCommentIdFromHref(partial.href),
          content: partial.content,
        })
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

function readEntryFbid(entry: Record<string, unknown>): string | null {
  return readString(entry.fbid) ?? readString(entry.fbId);
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
  const fbid = readEntryFbid(entry);
  const content =
    readString(findLabeledValue(labelValues, "Comment")?.value) ??
    readString(findLabeledValue(labelValues, "Text")?.value);

  if (href) {
    pushLikedItem(items, {
      href,
      authorUsername,
      likedAt,
      source,
      fbid,
      content,
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
      fbid,
      content,
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
  const fbid = readEntryFbid(entry);

  if (href) {
    pushLikedItem(items, {
      href,
      authorUsername,
      likedAt,
      source,
      fbid,
      content: value,
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
      fbid,
      content: value,
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
