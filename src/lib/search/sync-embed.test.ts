import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import type { SearchIndex } from "../storage";
import type { EmbeddingConfig } from "./embeddings";
import { storeEmbeddingsChunked } from "./sync-embed";
import { server } from "../../test/msw/server";

describe("shared embedding generation", () => {
  it("generates once then projects the same bytes to overlap", async () => {
    const inputs: string[][] = [];
    server.use(
      http.post(
        "https://api.voyageai.com/v1/embeddings",
        async ({ request }) => {
          const body = (await request.json()) as { input: string | string[] };
          inputs.push(Array.isArray(body.input) ? body.input : [body.input]);
          return HttpResponse.json({
            data: [{ index: 0, embedding: [1, 0] }],
          });
        },
      ),
    );
    const vectors = {
      saves: new Map<number, Float32Array>(),
      likes: new Map<number, Float32Array>(),
    };
    const profiles = new Map<string, EmbeddingConfig["profile"]>();
    const search = {
      vectorTableDimensions: vi.fn(async () => 2),
      recreateVectorTable: vi.fn(async (library: "saves" | "likes") => {
        vectors[library].clear();
      }),
      writeEmbeddingProfile: vi.fn(
        async (library: "saves" | "likes", index: string, profile: EmbeddingConfig["profile"]) => {
          profiles.set(`${library}:${index}`, profile);
        },
      ),
      getIndexedEmbeddingProfile: vi.fn(
        async (library: "saves" | "likes", index: string) =>
          profiles.get(`${library}:${index}`) ?? null,
      ),
      projectExistingEmbeddings: vi.fn(
        async (library: "saves" | "likes", _index: string, itemIds: number[]) => {
          const source = vectors[library === "saves" ? "likes" : "saves"];
          const projected = new Set<number>();
          for (const id of itemIds) {
            const embedding = source.get(id);
            if (!embedding) continue;
            vectors[library].set(id, embedding);
            projected.add(id);
          }
          return projected;
        },
      ),
      writeEmbeddingChunk: vi.fn(
        async (
          library: "saves" | "likes",
          _index: string,
          generated: Array<{ id: number; embedding: Float32Array }>,
        ) => {
          for (const row of generated) vectors[library].set(row.id, row.embedding);
        },
      ),
      writeEmbeddingProfileMeta: vi.fn(),
    } as unknown as SearchIndex;
    const config: EmbeddingConfig = {
      profile: {
        provider: "voyage",
        model: "voyage-3",
        dimensions: 2,
        endpoint: "https://api.voyageai.com/v1/embeddings",
      },
      apiKey: "test",
    };
    const media = {
      id: 7,
      authorUsername: "alice",
      shortcode: "Shared",
      mediaKey: "Shared",
      mediaType: "post",
    };

    await storeEmbeddingsChunked(
      "saves",
      "voyage",
      [{ ...media, collections: ["Recipes"] }],
      config,
      true,
      search,
    );
    await storeEmbeddingsChunked(
      "likes",
      "voyage",
      [{ ...media, source: "liked_posts" }],
      config,
      true,
      search,
    );

    expect(inputs).toEqual([["alice\nShared\nShared\npost"]]);
    expect(vectors.likes.get(7)).toBe(vectors.saves.get(7));
  });
});
