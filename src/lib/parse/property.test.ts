/**
 * Property-based / fuzz-style parser resilience (R3 property-parse).
 *
 * Uses fast-check with a fixed seed so CI is deterministic. Assertions focus
 * on: never throw; well-formed shapes yield valid mediaKeys; garbage / mutated
 * export trees degrade gracefully (0 items or warnings, not crashes).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseLikedExportJsonFiles } from "./likes";
import { parseExportJsonFiles } from "./saves";
import {
  syntheticLikedPostsJson,
  syntheticSavedPostsJson,
  syntheticSavedPostsLabelValuesJson,
} from "./synthetic";
import { mediaKeyFromHref } from "./types";

const FC_OPTS = { seed: 20260819, numRuns: 64 } as const;

const SAVES_PATH = "your_instagram_activity/saved/saved_posts.json";
const LIKES_PATH = "your_instagram_activity/likes/liked_posts.json";

const igHrefArb = fc
  .tuple(
    fc.constantFrom("p", "reel", "reels", "tv"),
    fc
      .stringMatching(/^[A-Za-z0-9_-]{6,16}$/)
      .filter((s) => s.length >= 6),
  )
  .map(([kind, code]) => `https://www.instagram.com/${kind}/${code}/`);

const usernameArb = fc
  .stringMatching(/^[a-z0-9._]{1,24}$/)
  .filter((s) => s.length >= 1 && !/^\.+$/.test(s));

const timestampArb = fc.integer({ min: 1_500_000_000, max: 1_900_000_000 });

const stringListEntryArb = fc.record({
  title: usernameArb,
  string_list_data: fc.array(
    fc.record({
      href: igHrefArb,
      timestamp: timestampArb,
      value: fc.option(usernameArb, { nil: undefined }),
    }),
    { minLength: 1, maxLength: 2 },
  ),
});

const labelValuesEntryArb = fc.record({
  timestamp: timestampArb,
  media: fc.constant([] as unknown[]),
  label_values: fc.tuple(
    fc.record({
      label: fc.constant("URL"),
      href: igHrefArb,
      value: igHrefArb,
    }),
    fc.record({
      title: fc.constant("Owner"),
      dict: fc.constant([
        {
          title: "",
          dict: [{ label: "Username", value: "prop.owner" }],
        },
      ]),
    }),
  ),
  fbid: fc.stringMatching(/^[0-9]{4,12}$/),
});

type TinyRng = {
  nextBoolean: () => boolean;
  nextInt: (min: number, max: number) => number;
};

function tinyRng(seed: number): TinyRng {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  return {
    nextBoolean: () => next() % 2 === 0,
    nextInt: (min, max) => min + (next() % (max - min + 1)),
  };
}

/** Mutate a JSON tree: replace random leaves with garbage types. */
function mutateJson(value: unknown, depth: number, rng: TinyRng): unknown {
  if (depth <= 0) {
    return rng.nextBoolean()
      ? null
      : rng.nextBoolean()
        ? 42
        : { broken: true };
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return value;
    const idx = rng.nextInt(0, value.length - 1);
    const copy = value.slice();
    copy[idx] = mutateJson(copy[idx], depth - 1, rng);
    return copy;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return value;
    const idx = rng.nextInt(0, entries.length - 1);
    const [k] = entries[idx]!;
    const copy = { ...(value as Record<string, unknown>) };
    if (rng.nextBoolean()) {
      copy[k] = mutateJson(copy[k], depth - 1, rng);
    } else {
      // Drop or rename a field — common Instagram format drift.
      delete copy[k];
      if (rng.nextBoolean()) copy[`x_${k}`] = "noise";
    }
    return copy;
  }
  return value;
}

describe("property-parse: well-formed saves", () => {
  it("string_list_data entries always yield mediaKeys matching hrefs", () => {
    fc.assert(
      fc.property(
        fc.array(stringListEntryArb, { minLength: 1, maxLength: 12 }),
        (entries) => {
          const content = JSON.stringify({ saved_saved_media: entries });
          const result = parseExportJsonFiles([
            { name: SAVES_PATH, content },
          ]);
          expect(result.warnings).toEqual([]);
          expect(result.items.length).toBeGreaterThan(0);
          for (const item of result.items) {
            expect(item.mediaKey).toBe(mediaKeyFromHref(item.href));
            expect(item.mediaKey.length).toBeGreaterThan(0);
            expect(item.href).toMatch(/instagram\.com\//i);
          }
        },
      ),
      FC_OPTS,
    );
  });

  it("label_values entries always yield mediaKeys + optional author", () => {
    fc.assert(
      fc.property(
        fc.array(labelValuesEntryArb, { minLength: 1, maxLength: 8 }),
        (entries) => {
          const content = JSON.stringify(entries);
          const result = parseExportJsonFiles([
            { name: SAVES_PATH, content },
          ]);
          expect(result.items.length).toBe(entries.length);
          for (const item of result.items) {
            expect(item.mediaKey).toBe(mediaKeyFromHref(item.href));
            expect(item.authorUsername).toBe("prop.owner");
          }
        },
      ),
      FC_OPTS,
    );
  });
});

describe("property-parse: well-formed likes", () => {
  it("likes_media_likes entries always yield mediaKeys matching hrefs", () => {
    fc.assert(
      fc.property(
        fc.array(stringListEntryArb, { minLength: 1, maxLength: 12 }),
        (entries) => {
          const content = JSON.stringify({ likes_media_likes: entries });
          const result = parseLikedExportJsonFiles([
            { name: LIKES_PATH, content },
          ]);
          expect(result.warnings).toEqual([]);
          expect(result.items.length).toBeGreaterThan(0);
          for (const item of result.items) {
            expect(item.mediaKey).toBe(mediaKeyFromHref(item.href));
            expect(item.source).toBe("liked_posts");
          }
        },
      ),
      FC_OPTS,
    );
  });
});

describe("property-parse: resilience", () => {
  it("never throws on arbitrary JSON documents named as saved/liked files", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (json) => {
        const content = JSON.stringify(json);
        expect(() =>
          parseExportJsonFiles([{ name: SAVES_PATH, content }]),
        ).not.toThrow();
        expect(() =>
          parseLikedExportJsonFiles([{ name: LIKES_PATH, content }]),
        ).not.toThrow();
      }),
      { ...FC_OPTS, numRuns: 100 },
    );
  });

  it("malformed JSON content yields a warning, not a throw", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 80 }).filter((s) => {
          try {
            JSON.parse(s);
            return false;
          } catch {
            return true;
          }
        }),
        (garbage) => {
          const saves = parseExportJsonFiles([
            { name: SAVES_PATH, content: garbage },
          ]);
          expect(saves.items).toEqual([]);
          expect(saves.warnings.some((w) => /malformed/i.test(w))).toBe(true);

          const likes = parseLikedExportJsonFiles([
            { name: LIKES_PATH, content: garbage },
          ]);
          expect(likes.items).toEqual([]);
          expect(likes.warnings.some((w) => /malformed/i.test(w))).toBe(true);
        },
      ),
      FC_OPTS,
    );
  });

  it("mutated well-formed trees never throw (format-drift fuzz)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 31 - 1 }), (seed) => {
        const base = JSON.parse(
          syntheticSavedPostsJson(5, { prefix: "Mut" }),
        ) as unknown;
        const mutated = mutateJson(base, 4, tinyRng(seed));
        const content = JSON.stringify(mutated);
        expect(() =>
          parseExportJsonFiles([{ name: SAVES_PATH, content }]),
        ).not.toThrow();
      }),
      { ...FC_OPTS, numRuns: 80 },
    );
  });

  it("duplicate hrefs collapse to a single mediaKey", () => {
    fc.assert(
      fc.property(igHrefArb, usernameArb, timestampArb, (href, user, ts) => {
        const entry = {
          title: user,
          string_list_data: [{ href, timestamp: ts, value: user }],
        };
        const content = JSON.stringify({
          saved_saved_media: [entry, entry, entry],
        });
        const result = parseExportJsonFiles([
          { name: SAVES_PATH, content },
        ]);
        expect(result.items).toHaveLength(1);
        expect(result.items[0]!.mediaKey).toBe(mediaKeyFromHref(href));
      }),
      FC_OPTS,
    );
  });
});

describe("property-parse: synthetic generators stay coherent", () => {
  it("saved / liked / label-values synthetics parse at small N", () => {
    const n = 25;
    const saves = parseExportJsonFiles([
      {
        name: SAVES_PATH,
        content: syntheticSavedPostsJson(n, { prefix: "GenS" }),
      },
    ]);
    expect(saves.items).toHaveLength(n);

    const likes = parseLikedExportJsonFiles([
      {
        name: LIKES_PATH,
        content: syntheticLikedPostsJson(n, { prefix: "GenL" }),
      },
    ]);
    expect(likes.items).toHaveLength(n);

    const labels = parseExportJsonFiles([
      {
        name: SAVES_PATH,
        content: syntheticSavedPostsLabelValuesJson(n, { prefix: "GenV" }),
      },
    ]);
    expect(labels.items).toHaveLength(n);
    expect(labels.items.every((i) => i.authorUsername)).toBe(true);
  });
});
