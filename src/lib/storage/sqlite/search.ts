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
import { searchFts } from "../../search/hybrid";
import { assessVectorIntegrity } from "../../search/vec-integrity";
import { assessSearchIndexGaps } from "../../search/readiness";

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

    allSavesSearchRows: async (itemIds) => allSavesSearchRows(sqlite, itemIds),
    allLikesSearchRows: async (itemIds) => allLikesSearchRows(sqlite, itemIds),

    searchFts: async (library, query, limit = 200) =>
      searchFts(library, query, limit, sqlite),

    assessVectorIntegrity: async (library, index, options) =>
      assessVectorIntegrity(library, index, sqlite, options),
    assessSearchIndexGaps: async () => assessSearchIndexGaps(),
  };
}
