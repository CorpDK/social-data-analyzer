/**
 * sqlite-vec table helpers: insert/upsert/count/profile/chunk write.
 * Extracted from sync.ts; rebuild orchestration stays there.
 */
import type Database from "better-sqlite3";
import { getSqlite } from "../db";
import {
  embeddingToBuffer,
  type EmbeddingConfig,
  type EmbeddingProfile,
} from "./embeddings";
import {
  profileIndexName,
  type SearchLibrary,
  type VectorIndexName,
  vectorTableName,
} from "./library";

export type IndexedEmbeddingProfileMeta = EmbeddingProfile & {
  updatedAt: number;
};

export type EmbeddingWriteMode = "insert-only" | "upsert";

type GeneratedEmbedding = { id: number; embedding: Float32Array };

export function recreateVectorTable(
  library: SearchLibrary,
  index: VectorIndexName,
  dimensions: number,
  sqlite: Database.Database,
) {
  const table = vectorTableName(library, index);
  sqlite.exec(`
    DROP TABLE IF EXISTS ${table};
    CREATE VIRTUAL TABLE ${table} USING vec0(
      item_id INTEGER PRIMARY KEY,
      embedding FLOAT[${dimensions}]
    );
  `);
}

export function writeEmbeddingProfile(
  library: SearchLibrary,
  index: VectorIndexName,
  profile: EmbeddingProfile,
  sqlite: Database.Database,
) {
  sqlite
    .prepare(
      `INSERT INTO embedding_index_profiles(
        index_name, provider, model, dimensions, endpoint, updated_at
      ) VALUES (?, ?, ?, ?, ?, unixepoch())
      ON CONFLICT(index_name) DO UPDATE SET
        provider = excluded.provider,
        model = excluded.model,
        dimensions = excluded.dimensions,
        endpoint = excluded.endpoint,
        updated_at = unixepoch()`,
    )
    .run(
      profileIndexName(library, index),
      profile.provider,
      profile.model,
      profile.dimensions,
      profile.endpoint,
    );
}

export function insertItemEmbedding(
  library: SearchLibrary,
  index: VectorIndexName,
  itemId: number,
  embedding: Float32Array,
  sqlite: Database.Database = getSqlite(),
) {
  sqlite
    .prepare(
      `INSERT INTO ${vectorTableName(library, index)}(item_id, embedding) VALUES (?, ?)`,
    )
    .run(BigInt(itemId), embeddingToBuffer(embedding));
}

export function upsertItemEmbedding(
  library: SearchLibrary,
  index: VectorIndexName,
  itemId: number,
  embedding: Float32Array,
  sqlite: Database.Database = getSqlite(),
) {
  const table = vectorTableName(library, index);
  const id = BigInt(itemId);
  sqlite.prepare(`DELETE FROM ${table} WHERE item_id = ?`).run(id);
  sqlite
    .prepare(`INSERT INTO ${table}(item_id, embedding) VALUES (?, ?)`)
    .run(id, embeddingToBuffer(embedding));
}

export function vecCount(
  library: SearchLibrary,
  index: VectorIndexName,
  sqlite: Database.Database = getSqlite(),
): number {
  if (vectorTableDimensions(library, index, sqlite) === null) return 0;
  return (
    sqlite
      .prepare(
        `SELECT count(*) AS c FROM ${vectorTableName(library, index)}`,
      )
      .get() as { c: number }
  ).c;
}

export function vectorTableDimensions(
  library: SearchLibrary,
  index: VectorIndexName,
  sqlite: Database.Database = getSqlite(),
): number | null {
  const row = sqlite
    .prepare(
      `SELECT sql FROM sqlite_master
       WHERE type = 'table' AND name = ?`,
    )
    .get(vectorTableName(library, index)) as
    | { sql: string | null }
    | undefined;
  const match = row?.sql?.match(/embedding\s+FLOAT\[(\d+)\]/i);
  return match ? Number(match[1]) : null;
}

export function getIndexedEmbeddingProfileMeta(
  library: SearchLibrary,
  index: VectorIndexName,
  sqlite: Database.Database = getSqlite(),
): IndexedEmbeddingProfileMeta | null {
  const row = sqlite
    .prepare(
      `SELECT provider, model, dimensions, endpoint, updated_at AS updatedAt
       FROM embedding_index_profiles WHERE index_name = ?`,
    )
    .get(profileIndexName(library, index)) as
    | IndexedEmbeddingProfileMeta
    | undefined;
  return row ?? null;
}

export function getIndexedEmbeddingProfile(
  library: SearchLibrary,
  index: VectorIndexName,
  sqlite: Database.Database = getSqlite(),
): EmbeddingProfile | null {
  const meta = getIndexedEmbeddingProfileMeta(library, index, sqlite);
  if (!meta) return null;
  return {
    provider: meta.provider,
    model: meta.model,
    dimensions: meta.dimensions,
    endpoint: meta.endpoint,
  };
}

export function embeddingProfilesMatch(
  left: EmbeddingProfile,
  right: EmbeddingProfile,
): boolean {
  return (
    left.provider === right.provider &&
    left.model === right.model &&
    left.dimensions === right.dimensions &&
    left.endpoint === right.endpoint
  );
}

export function vectorIndexMatchesConfig(
  library: SearchLibrary,
  index: VectorIndexName,
  config: EmbeddingConfig,
  sqlite: Database.Database = getSqlite(),
): boolean {
  const indexed = getIndexedEmbeddingProfile(library, index, sqlite);
  return Boolean(
    indexed &&
      vecCount(library, index, sqlite) > 0 &&
      vectorTableDimensions(library, index, sqlite) ===
        config.profile.dimensions &&
      embeddingProfilesMatch(indexed, config.profile),
  );
}

export function writeEmbeddingChunk(
  library: SearchLibrary,
  index: VectorIndexName,
  generated: GeneratedEmbedding[],
  writeMode: EmbeddingWriteMode,
  sqlite: Database.Database = getSqlite(),
) {
  if (generated.length === 0) return;
  sqlite.transaction(() => {
    for (const result of generated) {
      if (writeMode === "upsert") {
        upsertItemEmbedding(library, index, result.id, result.embedding, sqlite);
      } else {
        insertItemEmbedding(library, index, result.id, result.embedding, sqlite);
      }
    }
  })();
}
