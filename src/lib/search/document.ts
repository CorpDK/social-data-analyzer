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

type MediaSearchableItem = Pick<
  SearchableItem,
  "authorUsername" | "shortcode" | "mediaKey" | "mediaType"
>;

/** Stable embedding input shared by Saves and Likes membership projections. */
export function buildMediaEmbeddingText(item: MediaSearchableItem): string {
  return [
    item.authorUsername ?? "",
    item.shortcode ?? "",
    item.mediaKey,
    item.mediaType,
  ]
    .filter(Boolean)
    .join("\n");
}

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
  const combined = buildMediaEmbeddingText(item);

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
  const combined = buildMediaEmbeddingText(item);

  return {
    authorUsername,
    shortcode,
    mediaKey,
    mediaType,
    source,
    combined,
  };
}
