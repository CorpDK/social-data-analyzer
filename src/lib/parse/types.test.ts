import { describe, expect, it } from "vitest";
import {
  extractCommentIdFromHref,
  likedCommentMediaKey,
  mediaKeyFromHref,
} from "./types";

describe("mediaKeyFromHref shortcode case", () => {
  it("preserves distinct shortcodes that differ only by case", () => {
    const a = mediaKeyFromHref("https://www.instagram.com/p/AbCdEfGhIjK/");
    const b = mediaKeyFromHref("https://www.instagram.com/p/abcdefghiJk/");
    expect(a).toBe("AbCdEfGhIjK");
    expect(b).toBe("abcdefghiJk");
    expect(a).not.toBe(b);
  });

  it("preserves reel shortcode case and lowercases story usernames only", () => {
    expect(
      mediaKeyFromHref("https://www.instagram.com/reel/LikedFmtReel01/"),
    ).toBe("LikedFmtReel01");
    expect(
      mediaKeyFromHref("https://www.instagram.com/stories/Story.Author/99/"),
    ).toBe("story:story.author:99");
  });

  it("lowercases hostname for generic URL fallbacks", () => {
    expect(mediaKeyFromHref("https://WWW.Example.COM/Path/KeepCase")).toBe(
      "www.example.com/Path/KeepCase",
    );
  });
});

describe("likedCommentMediaKey", () => {
  it("prefers fbid then comment id over author collapse", () => {
    expect(
      likedCommentMediaKey({
        baseKey: "PostCode",
        authorUsername: "same.author",
        fbid: "9001",
        likedAt: new Date(1_700_000_000_000),
        content: "a",
      }),
    ).toBe("comment:fbid:9001");

    expect(
      likedCommentMediaKey({
        baseKey: "PostCode",
        authorUsername: "same.author",
        commentId: "cmt42",
        likedAt: new Date(1_700_000_000_000),
        content: "a",
      }),
    ).toBe("comment:id:cmt42");
  });

  it("keeps two comments by the same author on one post distinct via ts+content", () => {
    const a = likedCommentMediaKey({
      baseKey: "CommentLikedReel1",
      authorUsername: "comment.author",
      likedAt: new Date(1_740_000_100_000),
      content: "👍",
    });
    const b = likedCommentMediaKey({
      baseKey: "CommentLikedReel1",
      authorUsername: "comment.author",
      likedAt: new Date(1_740_000_200_000),
      content: "love this",
    });
    expect(a).not.toBe(b);
    expect(a).toContain("comment:CommentLikedReel1:comment.author:");
    expect(b).toContain("comment:CommentLikedReel1:comment.author:");
  });
});

describe("extractCommentIdFromHref", () => {
  it("reads /c/, query, and hash forms", () => {
    expect(
      extractCommentIdFromHref(
        "https://www.instagram.com/p/Abc/c/18001234567890123/",
      ),
    ).toBe("18001234567890123");
    expect(
      extractCommentIdFromHref(
        "https://www.instagram.com/reel/Abc/?comment_id=99",
      ),
    ).toBe("99");
    expect(
      extractCommentIdFromHref("https://www.instagram.com/p/Abc/#comment-77"),
    ).toBe("77");
  });
});
