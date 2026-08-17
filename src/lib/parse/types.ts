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

/** Comment permalink segments: /p/CODE/c/123/ or ?comment_id= / #comment- */
const COMMENT_PATH_ID_RE =
  /instagram\.com\/(?:p|reel|reels|tv)\/[^/?#]+\/c\/([A-Za-z0-9_-]+)/i;
const COMMENT_QUERY_ID_RE = /[?&#](?:comment_id|commentid)=([A-Za-z0-9_-]+)/i;
const COMMENT_HASH_ID_RE = /#comment-?([A-Za-z0-9_-]+)/i;

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

/**
 * Instagram shortcodes are case-sensitive identity keys. Preserve the case from
 * the href; only normalize hostnames / story usernames.
 */
export function mediaKeyFromHref(href: string): string | null {
  const shortcode = extractShortcode(href);
  if (shortcode) return shortcode;

  const story = extractStoryParts(href);
  if (story) {
    return story.storyId
      ? `story:${story.username}:${story.storyId}`
      : `story:${story.username}:${href.trim().toLowerCase().replace(/\/+$/, "")}`;
  }

  try {
    const url = new URL(href);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.replace(/\/+$/, "");
    const normalized = `${host}${path}`;
    return normalized || null;
  } catch {
    const cleaned = href.trim().replace(/\/+$/, "");
    return cleaned || null;
  }
}

/** Prefer explicit comment id from permalink / query / hash when present. */
export function extractCommentIdFromHref(href: string): string | null {
  const pathMatch = href.match(COMMENT_PATH_ID_RE);
  if (pathMatch?.[1]) return pathMatch[1];
  const queryMatch = href.match(COMMENT_QUERY_ID_RE);
  if (queryMatch?.[1]) return queryMatch[1];
  const hashMatch = href.match(COMMENT_HASH_ID_RE);
  if (hashMatch?.[1]) return hashMatch[1];
  return null;
}

function commentContentSlug(content: string | null | undefined): string {
  const trimmed = (content ?? "").trim();
  if (!trimmed) return "empty";
  // Keep identity stable and URL-safe without lowercasing (emoji/text matter).
  return trimmed
    .normalize("NFKC")
    .slice(0, 64)
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9._\-]/g, "");
}

/**
 * Liked-comment identity: prefer fbid / comment id; else post + author +
 * timestamp + content so distinct comments by the same author do not collapse.
 */
export function likedCommentMediaKey(input: {
  baseKey: string;
  authorUsername?: string | null;
  likedAt?: Date | null;
  fbid?: string | null;
  commentId?: string | null;
  content?: string | null;
}): string {
  const fbid = input.fbid?.trim();
  if (fbid) return `comment:fbid:${fbid}`;

  const commentId = input.commentId?.trim();
  if (commentId) return `comment:id:${commentId}`;

  const author = (input.authorUsername ?? "unknown").toLowerCase();
  const ts = input.likedAt?.getTime() ?? 0;
  const slug = commentContentSlug(input.content);
  return `comment:${input.baseKey}:${author}:${ts}:${slug || "empty"}`;
}
