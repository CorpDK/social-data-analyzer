import type Database from "better-sqlite3";
import type { SearchIndex } from "../ports";
import {
  ftsCount,
  removeItemSearch,
  removeLikedItemSearch,
  upsertItemFts,
  upsertLikedItemFts,
} from "../../search/sync-fts";
import {
  getIndexedEmbeddingProfile,
  getIndexedEmbeddingProfileMeta,
  insertItemEmbedding,
  recreateVectorTable,
  upsertItemEmbedding,
  vecCount,
  vectorIndexMatchesConfig,
  vectorTableDimensions,
  writeEmbeddingChunk,
  writeEmbeddingProfile,
} from "../../search/sync-vec-store";
import {
  allLikesSearchRows,
  allSavesSearchRows,
} from "../../search/sync-rows";
import { assessVectorIntegrity } from "../../search/vec-integrity";
import { vectorTableName } from "../../search/library";
import { embeddingToBuffer } from "../../search/embeddings";
import { searchSqliteFts } from "./search-query";

export function createSqliteSearchIndex(sqlite: Database.Database): SearchIndex {
  return {
    upsertItemFts: async (itemId, item) => {
      upsertItemFts(itemId, item, sqlite);
    },
    upsertLikedItemFts: async (itemId, item) => {
      upsertLikedItemFts(itemId, item, sqlite);
    },
    removeItemSearch: async (itemId) => {
      removeItemSearch(itemId, sqlite);
    },
    removeLikedItemSearch: async (itemId) => {
      removeLikedItemSearch(itemId, sqlite);
    },
    ftsCount: async (library = "saves") => ftsCount(library, sqlite),

    recreateVectorTable: async (library, index, dimensions) => {
      recreateVectorTable(library, index, dimensions, sqlite);
    },
    writeEmbeddingProfile: async (library, index, profile) => {
      writeEmbeddingProfile(library, index, profile, sqlite);
    },
    insertItemEmbedding: async (library, index, itemId, embedding) => {
      insertItemEmbedding(library, index, itemId, embedding, sqlite);
    },
    upsertItemEmbedding: async (library, index, itemId, embedding) => {
      upsertItemEmbedding(library, index, itemId, embedding, sqlite);
    },
    vecCount: async (library, index) => vecCount(library, index, sqlite),
    vectorTableDimensions: async (library, index) =>
      vectorTableDimensions(library, index, sqlite),
    getIndexedEmbeddingProfileMeta: async (library, index) =>
      getIndexedEmbeddingProfileMeta(library, index, sqlite),
    getIndexedEmbeddingProfile: async (library, index) =>
      getIndexedEmbeddingProfile(library, index, sqlite),
    vectorIndexMatchesConfig: async (library, index, config) =>
      vectorIndexMatchesConfig(library, index, config, sqlite),
    writeEmbeddingChunk: async (library, index, generated, writeMode) => {
      writeEmbeddingChunk(library, index, generated, writeMode, sqlite);
    },
    existingEmbeddingItemIds: async (library, index) => {
      if (vectorTableDimensions(library, index, sqlite) === null) return new Set();
      const rows = sqlite
        .prepare(`SELECT item_id AS id FROM ${vectorTableName(library, index)}`)
        .all() as Array<{ id: number | bigint }>;
      return new Set(rows.map((row) => Number(row.id)));
    },

    allSavesSearchRows: async (itemIds) => allSavesSearchRows(sqlite, itemIds),
    allLikesSearchRows: async (itemIds) => allLikesSearchRows(sqlite, itemIds),

    searchFts: async (library, query, limit = 200) =>
      searchSqliteFts(sqlite, library, query, limit),
    searchVector: async (library, index, embedding, limit) =>
      sqlite
        .prepare(
          `SELECT item_id AS id, distance
           FROM ${vectorTableName(library, index)}
           WHERE embedding MATCH ? AND k = ?
           ORDER BY distance`,
        )
        .all(embeddingToBuffer(embedding), limit) as Array<{
        id: number;
        distance: number;
      }>,

    assessVectorIntegrity: async (library, index, options) =>
      assessVectorIntegrity(library, index, sqlite, options),
    assessSearchIndexGaps: async () => {
      const count = (table: string) =>
        (
          sqlite.prepare(`SELECT count(*) AS c FROM ${table}`).get() as {
            c: number;
          }
        ).c;
      const savesItems = count("saved");
      const likesItems = count("liked");
      const savesFtsGap = Math.max(0, savesItems - ftsCount("saves", sqlite));
      const likesFtsGap = Math.max(0, likesItems - ftsCount("likes", sqlite));
      const savesLocal = vecCount("saves", "local", sqlite);
      const likesLocal = vecCount("likes", "local", sqlite);
      const savesLocalGap = savesItems > 0 && savesLocal < savesItems;
      const likesLocalGap = likesItems > 0 && likesLocal < likesItems;
      return {
        savesItems,
        likesItems,
        savesFtsGap,
        likesFtsGap,
        savesLocalGap,
        likesLocalGap,
        degraded:
          savesFtsGap > 0 ||
          likesFtsGap > 0 ||
          savesLocalGap ||
          likesLocalGap,
      };
    },
  };
}
