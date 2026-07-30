export type SearchableItem = {
  authorUsername: string | null;
  shortcode: string | null;
  mediaKey: string;
  mediaType: string;
  collections: string[];
};

export type LikedSearchableItem = {
  authorUsername: string | null;
  shortcode: string | null;
  mediaKey: string;
  mediaType: string;
  source: string;
};

export function buildSearchDocument(item: SearchableItem): {
  authorUsername: string;
  shortcode: string;
  mediaKey: string;
  mediaType: string;
  collections: string;
  combined: string;
} {
  const authorUsername = item.authorUsername ?? "";
  const shortcode = item.shortcode ?? "";
  const mediaKey = item.mediaKey;
  const mediaType = item.mediaType;
  const collections = item.collections.filter(Boolean).join(" ");
  const combined = [
    authorUsername,
    shortcode,
    mediaKey,
    mediaType,
    collections,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    authorUsername,
    shortcode,
    mediaKey,
    mediaType,
    collections,
    combined,
  };
}

export function buildLikedSearchDocument(item: LikedSearchableItem): {
  authorUsername: string;
  shortcode: string;
  mediaKey: string;
  mediaType: string;
  source: string;
  combined: string;
} {
  const authorUsername = item.authorUsername ?? "";
  const shortcode = item.shortcode ?? "";
  const mediaKey = item.mediaKey;
  const mediaType = item.mediaType;
  const source = item.source ?? "";
  const combined = [authorUsername, shortcode, mediaKey, mediaType, source]
    .filter(Boolean)
    .join("\n");

  return {
    authorUsername,
    shortcode,
    mediaKey,
    mediaType,
    source,
    combined,
  };
}
