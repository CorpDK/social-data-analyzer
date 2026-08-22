import type { Pool, PoolClient } from "pg";
import type { EmbeddingProfile } from "../../search/embeddings";
import { localEmbeddingConfig } from "../../search/embeddings";
import { profileIndexName } from "../../search/library";
import type { SearchLibrary, VectorIndexName } from "../../search/library";
import { embeddingProfilesMatch } from "../../search/sync-vec-store";
import type { SearchIndex } from "../ports";

const DIMENSIONS = 1024;

const searchTable = (library: SearchLibrary) =>
  library === "saves" ? "saved_items_search" : "liked_items_search";
const embeddingTable = (_library: SearchLibrary) => "media_embeddings";
const itemsTable = (library: SearchLibrary) =>
  library === "saves" ? "saved" : "liked";

function vectorLiteral(vector: Float32Array): string {
  if (vector.length !== DIMENSIONS) {
    throw new Error(
      `Postgres pgvector expects ${DIMENSIONS} dimensions, received ${vector.length}.`,
    );
  }
  return `[${Array.from(vector).join(",")}]`;
}

export function l2DistanceToCosineDistance(l2Distance: number): number {
  return (l2Distance * l2Distance) / 2;
}

export function cosineDistanceToL2Distance(cosineDistance: number): number {
  return Math.sqrt(Math.max(0, cosineDistance) * 2);
}

async function inTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function createPostgresSearchIndex(pool: Pool): SearchIndex {
  const profile = async (
    library: SearchLibrary,
    index: VectorIndexName,
  ) => {
    const result = await pool.query<{
      provider: EmbeddingProfile["provider"];
      model: string;
      dimensions: number;
      endpoint: string | null;
      updated_at: Date;
    }>(
      `SELECT provider, model, dimensions, endpoint, updated_at
       FROM embedding_index_profiles WHERE index_name = $1`,
      [profileIndexName(library, index)],
    );
    const row = result.rows[0];
    return row
      ? {
          provider: row.provider,
          model: row.model,
          dimensions: row.dimensions,
          endpoint: row.endpoint,
          updatedAt: Math.floor(row.updated_at.getTime() / 1000),
        }
      : null;
  };

  const countVectors = async (
    library: SearchLibrary,
    index: VectorIndexName,
  ) => {
    const result = await pool.query<{ count: string }>(
      `SELECT count(*) FROM ${embeddingTable(library)} e
       JOIN ${itemsTable(library)} i ON i.media_id=e.media_id
       WHERE e.provider = $1`,
      [index],
    );
    return Number(result.rows[0]?.count ?? 0);
  };

  const upsertEmbedding = (
    client: Pool | PoolClient,
    library: SearchLibrary,
    index: VectorIndexName,
    itemId: number,
    embedding: Float32Array,
    _insertOnly = false,
  ) =>
    client.query(
      `INSERT INTO ${embeddingTable(library)}(media_id, provider, embedding)
       VALUES ($1, $2, $3::vector)
       ON CONFLICT(media_id, provider) DO UPDATE SET embedding = excluded.embedding`,
      [itemId, index, vectorLiteral(embedding)],
    );

  return {
    upsertItemFts: async (itemId, item) => {
      await pool.query(
        `INSERT INTO saved_items_search(
           item_id, author_username, shortcode, media_key, media_type, collections
         ) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT(item_id) DO UPDATE SET
           author_username=excluded.author_username, shortcode=excluded.shortcode,
           media_key=excluded.media_key, media_type=excluded.media_type,
           collections=excluded.collections`,
        [
          itemId,
          item.authorUsername,
          item.shortcode,
          item.mediaKey,
          item.mediaType,
          item.collections.join(" "),
        ],
      );
    },
    upsertLikedItemFts: async (itemId, item) => {
      await pool.query(
        `INSERT INTO liked_items_search(
           item_id, author_username, shortcode, media_key, media_type, source
         ) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT(item_id) DO UPDATE SET
           author_username=excluded.author_username, shortcode=excluded.shortcode,
           media_key=excluded.media_key, media_type=excluded.media_type,
           source=excluded.source`,
        [
          itemId,
          item.authorUsername,
          item.shortcode,
          item.mediaKey,
          item.mediaType,
          item.source,
        ],
      );
    },
    removeItemSearch: async (itemId) => {
      await pool.query("DELETE FROM saved_items_search WHERE item_id = $1", [
        itemId,
      ]);
    },
    removeLikedItemSearch: async (itemId) => {
      await pool.query("DELETE FROM liked_items_search WHERE item_id = $1", [
        itemId,
      ]);
    },
    ftsCount: async (library = "saves") => {
      const result = await pool.query<{ count: string }>(
        `SELECT count(*) FROM ${searchTable(library)}`,
      );
      return Number(result.rows[0]?.count ?? 0);
    },
    recreateVectorTable: async (library, index, dimensions) => {
      if (dimensions !== DIMENSIONS) {
        throw new Error(
          `Postgres embeddings are fixed at ${DIMENSIONS} dimensions.`,
        );
      }
      // media_embeddings is canonical across memberships. A library rebuild
      // overwrites its rows below, but must not delete vectors still used by
      // the other library before they can be reused.
      void library;
      void index;
    },
    writeEmbeddingProfile: async (library, index, value) => {
      await pool.query(
        `INSERT INTO embedding_index_profiles(
           index_name, provider, model, dimensions, endpoint, updated_at
         ) VALUES ($1,$2,$3,$4,$5,now())
         ON CONFLICT(index_name) DO UPDATE SET provider=excluded.provider,
           model=excluded.model, dimensions=excluded.dimensions,
           endpoint=excluded.endpoint, updated_at=now()`,
        [
          profileIndexName(library, index),
          value.provider,
          value.model,
          value.dimensions,
          value.endpoint,
        ],
      );
    },
    insertItemEmbedding: async (library, index, itemId, embedding) => {
      await upsertEmbedding(pool, library, index, itemId, embedding, true);
    },
    upsertItemEmbedding: async (library, index, itemId, embedding) => {
      await upsertEmbedding(pool, library, index, itemId, embedding);
    },
    vecCount: countVectors,
    vectorTableDimensions: async () => DIMENSIONS,
    getIndexedEmbeddingProfileMeta: profile,
    getIndexedEmbeddingProfile: async (library, index) => {
      const value = await profile(library, index);
      if (!value) return null;
      const { updatedAt: _updatedAt, ...plain } = value;
      return plain;
    },
    vectorIndexMatchesConfig: async (library, index, config) => {
      const value = await profile(library, index);
      return Boolean(
        value &&
          (await countVectors(library, index)) > 0 &&
          value.dimensions === DIMENSIONS &&
          embeddingProfilesMatch(value, config.profile),
      );
    },
    writeEmbeddingChunk: async (library, index, generated, writeMode) => {
      if (generated.length === 0) return;
      await inTransaction(pool, async (client) => {
        for (const row of generated) {
          await upsertEmbedding(
            client,
            library,
            index,
            row.id,
            row.embedding,
            writeMode === "insert-only",
          );
        }
      });
    },
    existingEmbeddingItemIds: async (library, index) => {
      const result = await pool.query<{ item_id: number }>(
        `SELECT e.media_id AS item_id FROM ${embeddingTable(library)} e
         JOIN ${itemsTable(library)} i ON i.media_id=e.media_id
         WHERE e.provider=$1`,
        [index],
      );
      return new Set(result.rows.map((row) => row.item_id));
    },
    projectExistingEmbeddings: async (library, index, itemIds) => {
      if (itemIds.length === 0) return new Set();
      const sourceTable = itemsTable(library === "saves" ? "likes" : "saves");
      const targetTable = itemsTable(library);
      const result = await pool.query<{ item_id: number }>(
        `SELECT e.media_id AS item_id
         FROM ${embeddingTable(library)} e
         JOIN ${sourceTable} source ON source.media_id=e.media_id
         JOIN ${targetTable} target ON target.media_id=e.media_id
         WHERE e.provider=$1 AND e.media_id = ANY($2::int[])`,
        [index, itemIds],
      );
      return new Set(result.rows.map((row) => row.item_id));
    },
    allSavesSearchRows: async (itemIds) => {
      if (itemIds?.length === 0) return [];
      const values = itemIds ? [itemIds] : [];
      const where = itemIds ? "WHERE m.id = ANY($1::int[])" : "";
      const result = await pool.query<{
        id: number;
        author_username: string | null;
        shortcode: string | null;
        media_key: string;
        media_type: string;
        collections: string[];
      }>(
        `SELECT m.id, m.author_username, m.shortcode, m.media_key,
           m.media_type,
           coalesce(array_agg(ic.collection_name)
             FILTER (WHERE ic.collection_name IS NOT NULL), '{}') AS collections
         FROM saved s JOIN media m ON m.id=s.media_id
         LEFT JOIN item_collections ic ON ic.item_id = m.id
         ${where} GROUP BY m.id`,
        values,
      );
      return result.rows.map((row) => ({
        id: row.id,
        authorUsername: row.author_username,
        shortcode: row.shortcode,
        mediaKey: row.media_key,
        mediaType: row.media_type,
        collections: row.collections,
      }));
    },
    allLikesSearchRows: async (itemIds) => {
      if (itemIds?.length === 0) return [];
      const result = await pool.query<{
        id: number;
        author_username: string | null;
        shortcode: string | null;
        media_key: string;
        media_type: string;
        source: string;
      }>(
        `SELECT m.id, m.author_username, m.shortcode, m.media_key,
           m.media_type, l.source
         FROM liked l JOIN media m ON m.id=l.media_id
         ${itemIds ? "WHERE m.id = ANY($1::int[])" : ""}`,
        itemIds ? [itemIds] : [],
      );
      return result.rows.map((row) => ({
        id: row.id,
        authorUsername: row.author_username,
        shortcode: row.shortcode,
        mediaKey: row.media_key,
        mediaType: row.media_type,
        source: row.source,
      }));
    },
    searchFts: async (library, query, limit = 200) => {
      try {
        const result = await pool.query<{ id: number; rank: number }>(
          `SELECT item_id AS id,
             ts_rank(search_vector, websearch_to_tsquery('simple', $1)) AS rank
           FROM ${searchTable(library)}
           WHERE search_vector @@ websearch_to_tsquery('simple', $1)
           ORDER BY rank DESC LIMIT $2`,
          [query, limit],
        );
        return { hits: result.rows, degraded: false };
      } catch {
        return { hits: [], degraded: true };
      }
    },
    searchVector: async (library, index, embedding, limit) => {
      const result = await pool.query<{ id: number; distance: number }>(
        `SELECT e.media_id AS id, e.embedding <=> $1::vector AS distance
         FROM ${embeddingTable(library)} e
         JOIN ${itemsTable(library)} i ON i.media_id=e.media_id
         WHERE e.provider=$2
         ORDER BY e.embedding <=> $1::vector LIMIT $3`,
        [vectorLiteral(embedding), index, limit],
      );
      return result.rows.map((row) => ({
        id: row.id,
        distance: cosineDistanceToL2Distance(Number(row.distance)),
      }));
    },
    assessVectorIntegrity: async (library, index, options) => {
      const [count, indexedProfile, orphan] = await Promise.all([
        countVectors(library, index),
        profile(library, index),
        pool.query<{ count: string }>(
          `SELECT count(*) FROM ${embeddingTable(library)} e
           WHERE e.provider = $1 AND NOT EXISTS (
             SELECT 1 FROM ${itemsTable(library)} i WHERE i.media_id = e.media_id
           )`,
          [index],
        ),
      ]);
      const orphanVecRows = Number(orphan.rows[0]?.count ?? 0);
      const issues: string[] = [];
      if (orphanVecRows) {
        issues.push(`${orphanVecRows} orphan vector row(s) without matching items`);
      }
      if (indexedProfile && indexedProfile.dimensions !== DIMENSIONS) {
        issues.push(
          `vector(${DIMENSIONS}) disagrees with profile dimensions ${indexedProfile.dimensions}`,
        );
      }
      return {
        ok: issues.length === 0,
        tablePresent: count > 0,
        orphanVecRows,
        dimensions: DIMENSIONS,
        profileDimensions: indexedProfile?.dimensions ?? null,
        sampleChecked: Math.min(count, options?.sampleLimit ?? 64),
        sampleBadWidth: 0,
        issues,
      };
    },
    assessSearchIndexGaps: async () => {
      const [savesItems, likesItems, savesFts, likesFts, savesVec, likesVec] =
        await Promise.all([
          pool.query<{ count: string }>("SELECT count(*) FROM saved"),
          pool.query<{ count: string }>("SELECT count(*) FROM liked"),
          pool.query<{ count: string }>("SELECT count(*) FROM saved_items_search"),
          pool.query<{ count: string }>("SELECT count(*) FROM liked_items_search"),
          countVectors("saves", "local"),
          countVectors("likes", "local"),
        ]);
      const saves = Number(savesItems.rows[0]?.count ?? 0);
      const likes = Number(likesItems.rows[0]?.count ?? 0);
      const savesFtsGap = Math.max(
        0,
        saves - Number(savesFts.rows[0]?.count ?? 0),
      );
      const likesFtsGap = Math.max(
        0,
        likes - Number(likesFts.rows[0]?.count ?? 0),
      );
      const savesLocalGap =
        saves > 0 &&
        (savesVec < saves ||
          !(await profile("saves", "local")) ||
          !(await (async () => {
            const current = await profile("saves", "local");
            return current
              ? embeddingProfilesMatch(current, localEmbeddingConfig().profile)
              : false;
          })()));
      const likesLocalGap =
        likes > 0 &&
        (likesVec < likes ||
          !(await (async () => {
            const current = await profile("likes", "local");
            return current
              ? embeddingProfilesMatch(current, localEmbeddingConfig().profile)
              : false;
          })()));
      return {
        savesItems: saves,
        likesItems: likes,
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
