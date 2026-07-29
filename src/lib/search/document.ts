export type SearchableItem = {
  authorUsername: string | null;
  shortcode: string | null;
  mediaKey: string;
  mediaType: string;
  collections: string[];
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
