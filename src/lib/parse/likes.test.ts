import { describe, expect, it } from "vitest";
import { parseLikedExportJsonFiles } from "./likes";

describe("v11 likes parsing", () => {
  it("recognizes but stores no liked comments", () => {
    const result = parseLikedExportJsonFiles([{
      name: "your_instagram_activity/likes/liked_comments.json",
      content: JSON.stringify({
        likes_comment_likes: [{
          string_list_data: [{
            href: "https://www.instagram.com/p/PostCode/?comment_id=123",
            value: "comment author",
            timestamp: 1_700_000_000,
          }],
        }],
      }),
    }]);

    expect(result.likedJsonFiles).toHaveLength(1);
    expect(result.items).toEqual([]);
  });
});
