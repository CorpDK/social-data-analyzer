import fs from "node:fs";
import path from "node:path";
import type { TestContext } from "./harness";
import { assert } from "./harness";

const EDGES = path.join(process.cwd(), "scripts/fixtures/parse-edges");

function readEdge(name: string): string {
  return fs.readFileSync(path.join(EDGES, name), "utf8");
}

/**
 * Gate A+ parser edge-fixture sweep: label_values quirks, string_list_data,
 * empty caption / brand partner / hashtags shapes, missing Owner.Username,
 * collection-only items, and malformed-but-recoverable rows.
 */
export async function runParseEdgesSuite(_ctx: TestContext) {
  console.log("[suite] parse-edges");
  const { parseExportJsonFiles, parseLikedExportJsonFiles } = await import(
    "../../src/lib/parse-export"
  );

  // --- label_values edges (missing Username→Name, empty caption, brand, hashtags, value-only URL, camelCase) ---
  const labelEdges = parseExportJsonFiles([
    {
      name: "your_instagram_activity/saved/saved_posts.json",
      content: readEdge("saved-posts-label-values-edges.json"),
    },
  ]);

  const noUsername = labelEdges.items.find(
    (i) => i.mediaKey === "EdgeNoUsername01",
  );
  assert(
    noUsername?.authorUsername === "name.only.user" &&
      noUsername.mediaType === "reel" &&
      noUsername.savedAt != null,
    "Missing Owner.Username should fall back to Owner.Name when it looks like a username",
  );

  const valueOnly = labelEdges.items.find(
    (i) => i.mediaKey === "EdgeUrlValueOnly01",
  );
  assert(
    valueOnly?.authorUsername === "value.only.author" &&
      valueOnly.mediaType === "post",
    "URL label with value-only (no href) should still parse",
  );

  const camelLabel = labelEdges.items.find(
    (i) => i.mediaKey === "EdgeCamelLabel01",
  );
  assert(
    camelLabel?.authorUsername === "camel.label.user" &&
      camelLabel.mediaType === "igtv",
    "camelCase labelValues + /tv/ should parse as igtv",
  );

  assert(
    labelEdges.items.length === 3,
    `label_values edges should yield 3 recoverable items (got ${labelEdges.items.length}); null/garbage rows skipped`,
  );

  // --- string_list_data / string_map_data quirks ---
  const sld = parseExportJsonFiles([
    {
      name: "your_instagram_activity/saved/saved_posts.json",
      content: readEdge("saved-posts-string-list-quirks.json"),
    },
  ]);

  const sldTitle = sld.items.find((i) => i.mediaKey === "EdgeSldTitle01");
  assert(
    sldTitle?.authorUsername === "sld.title.author" &&
      sldTitle.mediaType === "reel",
    "string_list_data with generic 'Saved on' value should take author from title",
  );

  const sldCamel = sld.items.find((i) => i.mediaKey === "EdgeSldCamel01");
  assert(
    sldCamel?.authorUsername === "sld.value.author" &&
      sldCamel.mediaType === "post",
    "camelCase stringListData should parse href + username value",
  );

  const mapAuthor = sld.items.find((i) => i.mediaKey === "EdgeMapAuthor01");
  assert(
    mapAuthor?.authorUsername === "map.name.author" &&
      mapAuthor.mediaType === "reel",
    "string_map_data Saved on + title author should parse",
  );

  assert(
    sld.items.length === 3,
    `string_list quirks should yield 3 items with hrefs (got ${sld.items.length}); orphan no-href skipped`,
  );

  // --- collection-only (+ empty caption / empty brand / odd hashtag) ---
  const collOnly = parseExportJsonFiles([
    {
      name: "your_instagram_activity/saved/saved_collections.json",
      content: readEdge("saved-collections-only-edges.json"),
    },
  ]);

  const collItem = collOnly.items.find((i) => i.mediaKey === "EdgeCollOnly01");
  assert(
    collItem?.authorUsername === "coll.edge.user" &&
      collItem.collections.includes("Edge Collection") &&
      collItem.mediaType === "post",
    "Collection-only Media child with Owner.Name fallback + empty caption/brand should parse",
  );

  const collHref = collOnly.items.find(
    (i) => i.mediaKey === "EdgeCollHrefOnly",
  );
  assert(
    collHref?.collections.includes("Edge Collection") &&
      collHref.authorUsername == null &&
      collHref.mediaType === "reel",
    "Collection Media with URL href only (no Owner) should still tag the collection",
  );

  assert(
    collOnly.items.length === 2,
    `collection-only edges should yield 2 items (got ${collOnly.items.length})`,
  );

  // --- merge posts + collections: same shortcode gains collection tag ---
  const merged = parseExportJsonFiles([
    {
      name: "your_instagram_activity/saved/saved_posts.json",
      content: readEdge("saved-posts-label-values-edges.json"),
    },
    {
      name: "your_instagram_activity/saved/saved_collections.json",
      content: JSON.stringify([
        {
          timestamp: 1715000000,
          media: [],
          label_values: [
            { label: "Name", value: "Merged Tag" },
            {
              title: "Media",
              dict: [
                {
                  title: "",
                  dict: [
                    {
                      label: "URL",
                      href: "https://www.instagram.com/reel/EdgeNoUsername01/",
                      value: "https://www.instagram.com/reel/EdgeNoUsername01/",
                    },
                  ],
                },
              ],
            },
          ],
        },
      ]),
    },
  ]);
  const mergedReel = merged.items.find((i) => i.mediaKey === "EdgeNoUsername01");
  assert(
    mergedReel?.authorUsername === "name.only.user" &&
      mergedReel.collections.includes("Merged Tag"),
    "Posts + collections merge should keep author and add collection tag",
  );

  // --- malformed JSON file → warning, no throw ---
  const broken = parseExportJsonFiles([
    {
      name: "your_instagram_activity/saved/edge-broken.json",
      content: readEdge("not-json-but-named.json"),
    },
    {
      name: "your_instagram_activity/saved/saved_posts.json",
      content: readEdge("saved-posts-string-list-quirks.json"),
    },
  ]);
  assert(
    broken.warnings.some((w) => w.includes("edge-broken.json")),
    "Malformed saved JSON should warn and continue",
  );
  assert(
    broken.items.length === 3,
    "Sibling valid file should still parse after malformed sibling",
  );

  // --- legacy likes string_list_data ---
  const likedSld = parseLikedExportJsonFiles([
    {
      name: "your_instagram_activity/likes/liked_posts.json",
      content: readEdge("liked-posts-string-list.json"),
    },
  ]);
  const likedReel = likedSld.items.find((i) => i.mediaKey === "EdgeLikedSld01");
  assert(
    likedReel?.authorUsername === "legacy.liked.user" &&
      likedReel.mediaType === "reel" &&
      likedReel.source === "liked_posts",
    "likes_media_likes string_list_data should parse title author",
  );
  const likedCamel = likedSld.items.find(
    (i) => i.mediaKey === "EdgeLikedCamel01",
  );
  assert(
    likedCamel?.authorUsername === "legacy.value.author" &&
      likedCamel.mediaType === "post",
    "likes camelCase stringListData should parse value author",
  );
  assert(
    likedSld.items.length === 2,
    `liked string_list edges should yield 2 items (got ${likedSld.items.length})`,
  );

  const likedBroken = parseLikedExportJsonFiles([
    {
      name: "your_instagram_activity/likes/liked_posts.json",
      content: readEdge("not-json-but-named.json"),
    },
  ]);
  assert(
    likedBroken.warnings.some((w) => w.includes("liked_posts.json")),
    "Malformed likes JSON should warn and continue",
  );
  assert(
    likedBroken.items.length === 0,
    "Malformed likes-only parse should yield zero items",
  );

  console.log("parse-edges: ok");
}
