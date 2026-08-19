/**
 * Deterministic synthetic Instagram export JSON for benches / soaks / property
 * seeds. No DB or network.
 */

export type SyntheticMediaKind = "p" | "reel";

function shortcodeFromIndex(i: number, prefix = "Syn"): string {
  // Base36 keeps codes compact and URL-safe; pad for uniqueness at large N.
  return `${prefix}${i.toString(36).padStart(6, "0")}`;
}

export function syntheticSavedPostsJson(
  count: number,
  opts?: { prefix?: string; authorModulo?: number },
): string {
  const prefix = opts?.prefix ?? "Syn";
  const authorModulo = opts?.authorModulo ?? 50;
  const items = Array.from({ length: count }, (_, i) => {
    const kind: SyntheticMediaKind = i % 3 === 0 ? "reel" : "p";
    const code = shortcodeFromIndex(i, prefix);
    return {
      title: `user${i % authorModulo}`,
      string_list_data: [
        {
          href: `https://www.instagram.com/${kind}/${code}/`,
          timestamp: 1_700_000_000 + i,
          value: `user${i % authorModulo}`,
        },
      ],
    };
  });
  return JSON.stringify({ saved_saved_media: items });
}

export function syntheticLikedPostsJson(
  count: number,
  opts?: { prefix?: string; authorModulo?: number },
): string {
  const prefix = opts?.prefix ?? "Like";
  const authorModulo = opts?.authorModulo ?? 40;
  const items = Array.from({ length: count }, (_, i) => {
    const kind: SyntheticMediaKind = i % 4 === 0 ? "reel" : "p";
    const code = shortcodeFromIndex(i, prefix);
    return {
      title: `liker${i % authorModulo}`,
      string_list_data: [
        {
          href: `https://www.instagram.com/${kind}/${code}/`,
          timestamp: 1_700_100_000 + i,
        },
      ],
    };
  });
  return JSON.stringify({ likes_media_likes: items });
}

export function syntheticSavedPostsLabelValuesJson(
  count: number,
  opts?: { prefix?: string },
): string {
  const prefix = opts?.prefix ?? "Lbl";
  const items = Array.from({ length: count }, (_, i) => {
    const kind: SyntheticMediaKind = i % 2 === 0 ? "reel" : "p";
    const code = shortcodeFromIndex(i, prefix);
    const href = `https://www.instagram.com/${kind}/${code}/`;
    return {
      timestamp: 1_700_000_000 + i,
      media: [],
      label_values: [
        { label: "URL", value: href, href },
        {
          title: "Owner",
          dict: [
            {
              title: "",
              dict: [
                { label: "Username", value: `owner${i % 30}` },
                { label: "Name", value: `Owner ${i % 30}` },
              ],
            },
          ],
        },
      ],
      fbid: String(10_000 + i),
    };
  });
  return JSON.stringify(items);
}
