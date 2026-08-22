import { describe, expect, it } from "vitest";
import {
  buildLikedSearchDocument,
  buildMediaEmbeddingText,
  buildSearchDocument,
} from "./document";

describe("search documents", () => {
  it("uses the same media-only embedding text for saved and liked overlap", () => {
    const media = {
      authorUsername: "alice",
      shortcode: "AbC123",
      mediaKey: "AbC123",
      mediaType: "reel",
    };
    const saved = buildSearchDocument({
      ...media,
      collections: ["Recipes", "Private folder"],
    });
    const liked = buildLikedSearchDocument({
      ...media,
      source: "liked_reels",
    });

    expect(saved.combined).toBe(buildMediaEmbeddingText(media));
    expect(liked.combined).toBe(saved.combined);
    expect(saved.combined).not.toContain("Recipes");
    expect(liked.combined).not.toContain("liked_reels");
    expect(saved.collections).toBe("Recipes Private folder");
    expect(liked.source).toBe("liked_reels");
  });
});
