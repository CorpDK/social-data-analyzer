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

export const IG_URL_RE =
  /instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i;

/** e.g. /stories/username/1234567890/ or /stories/username/ */
const STORY_URL_RE =
  /instagram\.com\/stories\/([A-Za-z0-9._]+)(?:\/([0-9]+))?/i;

export const GENERIC_LABEL_RE =
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
