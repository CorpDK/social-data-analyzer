import type { Pool, PoolClient } from "pg";
import {
  mergeSchemaNodes,
  scrubSchemaSamples,
  type FileSchemaCatalogEntry,
  type JsonSchemaNode,
} from "../../json-schema-infer";
import type { ParsedLikedItem, ParsedSavedItem } from "../../parse-export";
import {
  emitProgress,
  throwIfCancelled,
  yieldToEventLoop,
} from "../../import/progress";
import type { ImportRunOptions } from "../../import/types";
import { ImportDiscardBusyError } from "../../import/rollback-partial";
import type {
  SchemaFileEntry,
  SchemaImportOption,
} from "../../schema-catalog";
import type { CatalogStore } from "../ports";

async function transaction<T>(
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

function parseStoredSchema(value: string): {
  schema: JsonSchemaNode | null;
  parseError: string | null;
} {
  try {
    const parsed = JSON.parse(value) as {
      schema?: JsonSchemaNode | null;
      parseError?: string | null;
    };
    return {
      schema: parsed.schema ? scrubSchemaSamples(parsed.schema) : null,
      parseError: parsed.parseError ?? null,
    };
  } catch {
    return { schema: null, parseError: "Invalid stored schema_json" };
  }
}

async function schemaOptions(pool: Pool): Promise<SchemaImportOption[]> {
  const result = await pool.query<{
    id: number;
    filename: string;
    imported_at: Date;
    status: string;
    schema_file_count: number;
  }>(
    `SELECT i.id, i.filename, i.imported_at, i.status,
       count(s.id)::int AS schema_file_count
     FROM imports i LEFT JOIN import_schemas s ON s.import_id=i.id
     GROUP BY i.id ORDER BY i.imported_at DESC`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    filename: row.filename,
    importedAt: row.imported_at,
    status: row.status,
    schemaFileCount: row.schema_file_count,
    hasSchemas: row.schema_file_count > 0,
  }));
}

async function schemasForImport(
  pool: Pool,
  importId: number,
): Promise<SchemaFileEntry[]> {
  const result = await pool.query<{
    import_id: number;
    file_path: string;
    byte_size: number;
    truncated_read: boolean;
    top_level_type: string;
    schema_json: string;
  }>(
    `SELECT import_id, file_path, byte_size, truncated_read, top_level_type,
       schema_json FROM import_schemas WHERE import_id=$1 ORDER BY file_path`,
    [importId],
  );
  return result.rows.map((row) => ({
    filePath: row.file_path,
    byteSize: row.byte_size,
    truncatedRead: row.truncated_read,
    topLevelType: row.top_level_type,
    ...parseStoredSchema(row.schema_json),
    importId: row.import_id,
  }));
}

async function aggregatedSchemas(pool: Pool): Promise<SchemaFileEntry[]> {
  const result = await pool.query<{
    import_id: number;
    filename: string;
    file_path: string;
    byte_size: number;
    truncated_read: boolean;
    top_level_type: string;
    schema_json: string;
  }>(
    `SELECT s.import_id, i.filename, s.file_path, s.byte_size,
       s.truncated_read, s.top_level_type, s.schema_json
     FROM import_schemas s JOIN imports i ON i.id=s.import_id
     ORDER BY s.file_path, i.imported_at DESC`,
  );
  const entries = new Map<string, SchemaFileEntry>();
  for (const row of result.rows) {
    const parsed = parseStoredSchema(row.schema_json);
    const existing = entries.get(row.file_path);
    if (!existing) {
      entries.set(row.file_path, {
        filePath: row.file_path,
        byteSize: row.byte_size,
        truncatedRead: row.truncated_read,
        topLevelType: row.top_level_type,
        ...parsed,
        imports: [{ id: row.import_id, filename: row.filename }],
      });
      continue;
    }
    existing.byteSize = Math.max(existing.byteSize, row.byte_size);
    existing.truncatedRead ||= row.truncated_read;
    if (existing.topLevelType !== row.top_level_type) {
      existing.topLevelType = [
        ...new Set(
          `${existing.topLevelType}|${row.top_level_type}`
            .split("|")
            .filter((value) => value && value !== "unknown"),
        ),
      ]
        .sort()
        .join("|");
    }
    if (existing.schema && parsed.schema) {
      existing.schema = mergeSchemaNodes(existing.schema, parsed.schema);
    } else {
      existing.schema ??= parsed.schema;
    }
    existing.parseError ??= parsed.parseError;
    existing.imports?.push({ id: row.import_id, filename: row.filename });
  }
  return [...entries.values()].sort((a, b) =>
    a.filePath.localeCompare(b.filePath),
  );
}

async function countImportRows(pool: Pool, importId: number) {
  const result = await pool.query<{
    items_added: number;
    items_touched: number;
    likes_added: number;
    likes_touched: number;
  }>(
    `SELECT
      (SELECT count(*)::int FROM saved WHERE first_seen_import_id=$1) items_added,
      (SELECT count(*)::int FROM saved WHERE last_seen_import_id=$1) items_touched,
      (SELECT count(*)::int FROM liked WHERE first_seen_import_id=$1) likes_added,
      (SELECT count(*)::int FROM liked WHERE last_seen_import_id=$1) likes_touched`,
    [importId],
  );
  const row = result.rows[0]!;
  return {
    itemsAdded: row.items_added,
    itemsUpdated: Math.max(0, row.items_touched - row.items_added),
    likesAdded: row.likes_added,
    likesUpdated: Math.max(0, row.likes_touched - row.likes_added),
  };
}

async function applySave(
  client: PoolClient,
  importId: number,
  item: ParsedSavedItem,
) {
  const existing = await client.query<{
    id: number;
    href: string;
    shortcode: string | null;
    media_key: string;
    media_type: string;
    author_username: string | null;
  }>("SELECT * FROM media WHERE media_key=$1", [item.mediaKey]);
  const row = existing.rows[0];
  let id: number;
  let mediaChanged = false;
  if (!row) {
    const inserted = await client.query<{ id: number }>(
      `INSERT INTO media(media_key,href,shortcode,media_type,author_username)
       VALUES($1,$2,$3,$4,$5) RETURNING id`,
      [
        item.mediaKey,
        item.href,
        item.shortcode,
        item.mediaType,
        item.authorUsername,
      ],
    );
    id = inserted.rows[0]!.id;
    mediaChanged = true;
  } else {
    id = row.id;
    const nextAuthor = item.authorUsername || row.author_username;
    const nextType =
      item.mediaType !== "unknown" ? item.mediaType : row.media_type;
    mediaChanged =
      item.href !== row.href ||
      nextAuthor !== row.author_username ||
      nextType !== row.media_type;
    await client.query(
      `UPDATE media SET href=$1, author_username=$2, media_type=$3,
       updated_at=now() WHERE id=$4`,
      [item.href, nextAuthor, nextType, id],
    );
  }
  const membership = await client.query<{ saved_at: Date | null }>(
    "SELECT saved_at FROM saved WHERE media_id=$1",
    [id],
  );
  const savedRow = membership.rows[0];
  const nextSavedAt =
    item.savedAt && (!savedRow?.saved_at || item.savedAt > savedRow.saved_at)
      ? item.savedAt
      : (savedRow?.saved_at ?? null);
  if (!savedRow) {
    await client.query(
      `INSERT INTO saved(media_id,saved_at,first_seen_import_id,last_seen_import_id)
       VALUES($1,$2,$3,$3)`,
      [id, nextSavedAt, importId],
    );
  } else {
    await client.query(
      `UPDATE saved SET saved_at=$1,last_seen_import_id=$2,updated_at=now()
       WHERE media_id=$3`,
      [nextSavedAt, importId, id],
    );
  }
  for (const name of item.collections.map((value) => value.trim()).filter(Boolean)) {
    await client.query(
      `INSERT INTO item_collections(item_id,collection_name) VALUES($1,$2)
       ON CONFLICT(item_id,collection_name) DO NOTHING`,
      [id, name],
    );
  }
  const collections = await client.query<{ collection_name: string }>(
    "SELECT collection_name FROM item_collections WHERE item_id=$1",
    [id],
  );
  await client.query(
    `INSERT INTO saved_items_search(
       item_id,author_username,shortcode,media_key,media_type,collections)
     SELECT id,author_username,shortcode,media_key,media_type,$2
       FROM media WHERE id=$1
     ON CONFLICT(item_id) DO UPDATE SET
       author_username=excluded.author_username,shortcode=excluded.shortcode,
       media_key=excluded.media_key,media_type=excluded.media_type,
       collections=excluded.collections`,
    [id, collections.rows.map((value) => value.collection_name).join(" ")],
  );
  const changed = mediaChanged || !savedRow || nextSavedAt !== savedRow.saved_at;
  return { kind: changed ? (savedRow ? "updated" : "added") : "skipped", id };
}

async function applyLike(
  client: PoolClient,
  importId: number,
  item: ParsedLikedItem,
) {
  if (
    item.source === "liked_comments" ||
    item.mediaType === "comment" ||
    item.mediaKey.startsWith("comment:")
  ) {
    return { kind: "skipped" as const, id: null };
  }
  const existing = await client.query<{
    id: number;
    href: string;
    media_type: string;
    author_username: string | null;
  }>("SELECT * FROM media WHERE media_key=$1", [item.mediaKey]);
  const row = existing.rows[0];
  let id: number;
  let mediaChanged = false;
  if (!row) {
    const inserted = await client.query<{ id: number }>(
      `INSERT INTO media(media_key,href,shortcode,media_type,author_username)
       VALUES($1,$2,$3,$4,$5) RETURNING id`,
      [
        item.mediaKey,
        item.href,
        item.shortcode,
        item.mediaType,
        item.authorUsername,
      ],
    );
    id = inserted.rows[0]!.id;
    mediaChanged = true;
  } else {
    id = row.id;
    const nextAuthor = item.authorUsername || row.author_username;
    const nextType =
      item.mediaType !== "unknown" ? item.mediaType : row.media_type;
    mediaChanged =
      item.href !== row.href ||
      nextAuthor !== row.author_username ||
      nextType !== row.media_type;
    await client.query(
      `UPDATE media SET href=$1,author_username=$2,media_type=$3,
       updated_at=now() WHERE id=$4`,
      [item.href, nextAuthor, nextType, id],
    );
  }
  const membership = await client.query<{ liked_at: Date | null; source: string }>(
    "SELECT liked_at,source FROM liked WHERE media_id=$1",
    [id],
  );
  const likedRow = membership.rows[0];
  const nextLikedAt =
    item.likedAt && (!likedRow?.liked_at || item.likedAt > likedRow.liked_at)
      ? item.likedAt
      : (likedRow?.liked_at ?? null);
  if (!likedRow) {
    await client.query(
      `INSERT INTO liked(media_id,liked_at,source,first_seen_import_id,last_seen_import_id)
       VALUES($1,$2,$3,$4,$4)`,
      [id, nextLikedAt, item.source, importId],
    );
  } else {
    await client.query(
      `UPDATE liked SET liked_at=$1,source=$2,last_seen_import_id=$3,
       updated_at=now() WHERE media_id=$4`,
      [nextLikedAt, item.source, importId, id],
    );
  }
  await client.query(
    `INSERT INTO liked_items_search(
       item_id,author_username,shortcode,media_key,media_type,source)
     SELECT m.id,m.author_username,m.shortcode,m.media_key,m.media_type,l.source
       FROM media m JOIN liked l ON l.media_id=m.id WHERE m.id=$1
     ON CONFLICT(item_id) DO UPDATE SET
       author_username=excluded.author_username,shortcode=excluded.shortcode,
       media_key=excluded.media_key,media_type=excluded.media_type,
       source=excluded.source`,
    [id],
  );
  const changed = mediaChanged || !likedRow ||
    nextLikedAt !== likedRow.liked_at || item.source !== likedRow.source;
  return { kind: changed ? (likedRow ? "updated" : "added") : "skipped", id };
}

async function applyItems<T extends ParsedSavedItem | ParsedLikedItem>(
  pool: Pool,
  importId: number,
  items: T[],
  options: ImportRunOptions | undefined,
  kind: "saves" | "likes",
) {
  let added = 0;
  let updated = 0;
  let skipped = 0;
  const changedIds: number[] = [];
  for (let index = 0; index < items.length; index += 1) {
    throwIfCancelled(options?.shouldCancel);
    const outcome = await transaction(pool, (client) =>
      kind === "saves"
        ? applySave(client, importId, items[index] as ParsedSavedItem)
        : applyLike(client, importId, items[index] as ParsedLikedItem),
    );
    if (outcome.kind === "added") added += 1;
    else if (outcome.kind === "updated") updated += 1;
    else skipped += 1;
    if (outcome.kind !== "skipped" && outcome.id != null) changedIds.push(outcome.id);
    if ((index + 1) % 20 === 0 || index + 1 === items.length) {
      await emitProgress(options?.onProgress, {
        phase: "writing",
        processed: index + 1,
        total: Math.max(1, items.length),
        message: `Writing ${kind}… ${index + 1}/${items.length}`,
      });
      await yieldToEventLoop();
    }
  }
  return { added, updated, skipped, changedIds };
}

export function createPostgresCatalogStore(pool: Pool): CatalogStore {
  return {
    getStats: async () => {
      const result = await pool.query<{
        total_items: number;
        posts: number;
        reels: number;
        authors: number;
        total_likes: number;
        liked_posts: number;
        liked_reels: number;
        liked_stories: number;
        liked_comments: number;
        import_count: number;
      }>(
        `SELECT
          (SELECT count(*)::int FROM saved) total_items,
          (SELECT count(*)::int FROM saved s JOIN media m ON m.id=s.media_id WHERE m.media_type='post') posts,
          (SELECT count(*)::int FROM saved s JOIN media m ON m.id=s.media_id WHERE m.media_type='reel') reels,
          (SELECT count(DISTINCT m.author_username)::int FROM saved s JOIN media m ON m.id=s.media_id) authors,
          (SELECT count(*)::int FROM liked) total_likes,
          (SELECT count(*)::int FROM liked l JOIN media m ON m.id=l.media_id WHERE m.media_type='post') liked_posts,
          (SELECT count(*)::int FROM liked l JOIN media m ON m.id=l.media_id WHERE m.media_type='reel') liked_reels,
          (SELECT count(*)::int FROM liked l JOIN media m ON m.id=l.media_id WHERE m.media_type='story') liked_stories,
          0::int liked_comments,
          (SELECT count(*)::int FROM imports) import_count`,
      );
      const row = result.rows[0]!;
      const [top, topLikes, collections, recent] = await Promise.all([
        pool.query<{ author_username: string | null; total: number }>(
          `SELECT m.author_username,count(*)::int total FROM saved s
           JOIN media m ON m.id=s.media_id
           WHERE m.author_username IS NOT NULL GROUP BY m.author_username
           ORDER BY total DESC LIMIT 10`,
        ),
        pool.query<{ author_username: string | null; total: number }>(
          `SELECT m.author_username,count(*)::int total FROM liked l
           JOIN media m ON m.id=l.media_id
           WHERE m.author_username IS NOT NULL GROUP BY m.author_username
           ORDER BY total DESC LIMIT 10`,
        ),
        pool.query<{ collection_name: string; total: number }>(
          `SELECT collection_name,count(*)::int total FROM item_collections
           GROUP BY collection_name ORDER BY total DESC LIMIT 12`,
        ),
        pool.query("SELECT * FROM imports ORDER BY imported_at DESC LIMIT 5"),
      ]);
      return {
        totalItems: row.total_items,
        posts: row.posts,
        reels: row.reels,
        authors: row.authors,
        totalLikes: row.total_likes,
        likedPosts: row.liked_posts,
        likedReels: row.liked_reels,
        likedStories: row.liked_stories,
        likedComments: row.liked_comments,
        importCount: row.import_count,
        topAuthors: top.rows.map((value) => ({
          authorUsername: value.author_username ?? "unknown",
          total: value.total,
        })),
        topLikedAuthors: topLikes.rows.map((value) => ({
          authorUsername: value.author_username ?? "unknown",
          total: value.total,
        })),
        collections: collections.rows.map((value) => ({
          collectionName: value.collection_name,
          total: value.total,
        })),
        recentImports: recent.rows.map(mapImport),
      };
    },
    listSaves: async (query) => {
      const page = Math.max(1, Math.floor(query.page ?? 1));
      const pageSize = Math.min(100, Math.max(1, Math.floor(query.pageSize ?? 25)));
      const values: unknown[] = [];
      const filters: string[] = [];
      const add = (value: unknown) => {
        values.push(value);
        return `$${values.length}`;
      };
      let searchMode: "none" | "fts" | "like" = "none";
      if (query.q?.trim()) {
        const p = add(query.q.trim());
        filters.push(
          `EXISTS (SELECT 1 FROM saved_items_search x WHERE x.item_id=m.id
           AND x.search_vector @@ websearch_to_tsquery('simple', ${p}))`,
        );
        searchMode = "fts";
      }
      if (query.type && query.type !== "all")
        filters.push(`m.media_type=${add(query.type)}`);
      if (query.author) filters.push(`m.author_username=${add(query.author)}`);
      if (query.collection)
        filters.push(
          `EXISTS (SELECT 1 FROM item_collections c WHERE c.item_id=m.id
           AND c.collection_name=${add(query.collection)})`,
        );
      if (query.membership === "both")
        filters.push(
          "EXISTS (SELECT 1 FROM liked l WHERE l.media_id=m.id)",
        );
      const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
      const count = await pool.query<{ count: string }>(
        `SELECT count(*) FROM saved i JOIN media m ON m.id=i.media_id ${where}`,
        values,
      );
      const limit = add(pageSize);
      const offset = add((page - 1) * pageSize);
      const rows = await pool.query(
        `SELECT m.*,i.saved_at,i.first_seen_import_id,i.last_seen_import_id,
           EXISTS(SELECT 1 FROM liked l WHERE l.media_id=m.id) liked,
           coalesce(array_agg(c.collection_name)
           FILTER (WHERE c.collection_name IS NOT NULL),'{}') collections
         FROM saved i JOIN media m ON m.id=i.media_id
         LEFT JOIN item_collections c ON c.item_id=m.id
         ${where} GROUP BY m.id,i.media_id
         ORDER BY i.saved_at DESC NULLS LAST,m.id DESC
         LIMIT ${limit} OFFSET ${offset}`,
        values,
      );
      const total = Number(count.rows[0]?.count ?? 0);
      return {
        items: rows.rows.map(mapSaved),
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
        searchMode,
        searchProvider: null,
        providerFallback: false,
        providerFallbackReason: undefined,
        totalCapped: false,
        searchCap: query.q?.trim() ? 10_000 : undefined,
      };
    },
    listLikes: async (query) => {
      const page = Math.max(1, Math.floor(query.page ?? 1));
      const pageSize = Math.min(100, Math.max(1, Math.floor(query.pageSize ?? 25)));
      const values: unknown[] = [];
      const filters: string[] = [];
      const add = (value: unknown) => {
        values.push(value);
        return `$${values.length}`;
      };
      let searchMode: "none" | "fts" = "none";
      if (query.q?.trim()) {
        const p = add(query.q.trim());
        filters.push(
          `EXISTS (SELECT 1 FROM liked_items_search x WHERE x.item_id=m.id
           AND x.search_vector @@ websearch_to_tsquery('simple', ${p}))`,
        );
        searchMode = "fts";
      }
      if (query.type && query.type !== "all")
        filters.push(`m.media_type=${add(query.type)}`);
      if (query.author) filters.push(`m.author_username=${add(query.author)}`);
      if (query.membership === "both")
        filters.push(
          "EXISTS (SELECT 1 FROM saved s WHERE s.media_id=m.id)",
        );
      const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
      const count = await pool.query<{ count: string }>(
        `SELECT count(*) FROM liked i JOIN media m ON m.id=i.media_id ${where}`,
        values,
      );
      const limit = add(pageSize);
      const offset = add((page - 1) * pageSize);
      const rows = await pool.query(
        `SELECT m.*,i.liked_at,i.source,i.first_seen_import_id,i.last_seen_import_id,
           EXISTS(SELECT 1 FROM saved s WHERE s.media_id=m.id) also_saved
         FROM liked i JOIN media m ON m.id=i.media_id ${where}
         ORDER BY i.liked_at DESC NULLS LAST,m.id DESC
         LIMIT ${limit} OFFSET ${offset}`,
        values,
      );
      const total = Number(count.rows[0]?.count ?? 0);
      return {
        items: rows.rows.map(mapLiked),
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
        searchMode,
        searchProvider: null,
        providerFallback: false,
        providerFallbackReason: undefined,
        totalCapped: false,
        searchCap: query.q?.trim() ? 10_000 : undefined,
      };
    },
    listImports: async () => {
      const result = await pool.query("SELECT * FROM imports ORDER BY imported_at DESC");
      return result.rows.map(mapImport);
    },
    getImportById: async (id) => {
      const result = await pool.query("SELECT * FROM imports WHERE id=$1", [id]);
      return result.rows[0] ? mapImport(result.rows[0]) : undefined;
    },
    listSavesFilterOptions: async () => {
      const [authors, collections] = await Promise.all([
        pool.query<{ author_username: string }>(
          `SELECT DISTINCT m.author_username FROM saved s
           JOIN media m ON m.id=s.media_id
           WHERE m.author_username IS NOT NULL ORDER BY m.author_username`,
        ),
        pool.query<{ collection_name: string }>(
          "SELECT DISTINCT collection_name FROM item_collections ORDER BY collection_name",
        ),
      ]);
      return {
        authors: authors.rows.map((row) => row.author_username),
        collections: collections.rows.map((row) => row.collection_name),
      };
    },
    listLikesFilterOptions: async () => {
      const result = await pool.query<{ author_username: string }>(
        `SELECT DISTINCT m.author_username FROM liked l
         JOIN media m ON m.id=l.media_id
         WHERE m.author_username IS NOT NULL ORDER BY m.author_username`,
      );
      return { authors: result.rows.map((row) => row.author_username) };
    },
    listSchemaImportOptions: () => schemaOptions(pool),
    getSchemasForImport: (id) => schemasForImport(pool, id),
    getAggregatedSchemas: () => aggregatedSchemas(pool),
    getSchemaCatalog: async (param) => {
      const imports = await schemaOptions(pool);
      if (!param || param === "all") {
        const files = await aggregatedSchemas(pool);
        return {
          mode: "all",
          importId: null,
          imports,
          files,
          emptyReason: files.length ? null : "No schema catalogs yet.",
        };
      }
      const id = Number(param);
      if (!Number.isFinite(id) || id <= 0) {
        return {
          mode: "import",
          importId: null,
          imports,
          files: [],
          emptyReason: "Invalid import id.",
        };
      }
      const files = imports.some((row) => row.id === id)
        ? await schemasForImport(pool, id)
        : [];
      return {
        mode: "import",
        importId: id,
        imports,
        files,
        emptyReason: files.length ? null : "Import not found or has no schema catalog.",
      };
    },
    persistImportSchemas: async (importId, catalog) => {
      await transaction(pool, async (client) => {
        await client.query("DELETE FROM import_schemas WHERE import_id=$1", [
          importId,
        ]);
        for (const entry of catalog) {
          await insertSchema(client, importId, entry);
        }
      });
    },
    applyParsedItems: (id, items, options) =>
      applyItems(pool, id, items, options, "saves"),
    applyLikedItems: (id, items, options) =>
      applyItems(pool, id, items, options, "likes"),
    appendImportNotes: async (id, extra) => {
      await pool.query(
        `UPDATE imports SET notes=CASE WHEN notes IS NULL OR notes=''
          THEN $2 ELSE notes || E'\\n' || $2 END WHERE id=$1`,
        [id, extra],
      );
    },
    countPersistedImportRows: (id) => countImportRows(pool, id),
    rollbackImportInserts: (id) => rollback(pool, id),
    discardImportInserts: async (id) => {
      const active = await pool.query<{ id: number }>(
        `SELECT id FROM import_jobs WHERE import_id=$1
         AND state IN ('pending','running') LIMIT 1`,
        [id],
      );
      if (active.rows[0]) {
        throw new ImportDiscardBusyError(
          `Import job #${active.rows[0].id} is still active; cancel it before discarding rows.`,
        );
      }
      return rollback(pool, id);
    },
    findCompletedImportByHash: async (contentHash) => {
      const result = await pool.query<{ id: number }>(
        "SELECT id FROM imports WHERE content_hash=$1 AND status='completed' LIMIT 1",
        [contentHash],
      );
      return result.rows[0] ?? null;
    },
    createImport: async (input) => {
      const result = await pool.query<{ id: number; error: string | null }>(
        `INSERT INTO imports(
           filename,content_hash,status,error,items_found,notes
         ) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,error`,
        [
          input.filename,
          input.contentHash,
          input.status,
          input.error ?? null,
          input.itemsFound ?? 0,
          input.notes ?? null,
        ],
      );
      return result.rows[0]!;
    },
    updateImport: async (id, patch) => {
      const values: unknown[] = [];
      const sets: string[] = [];
      const add = (column: string, value: unknown) => {
        if (value === undefined) return;
        values.push(value);
        sets.push(`${column}=$${values.length}`);
      };
      add("status", patch.status);
      add("error", patch.error);
      add("items_added", patch.itemsAdded);
      add("items_updated", patch.itemsUpdated);
      add("items_skipped", patch.itemsSkipped);
      add("notes", patch.notes);
      if (sets.length === 0) return;
      values.push(id);
      await pool.query(
        `UPDATE imports SET ${sets.join(", ")} WHERE id=$${values.length}`,
        values,
      );
    },
  };
}

function mapImport(row: Record<string, unknown>) {
  return {
    id: Number(row.id),
    filename: String(row.filename),
    contentHash: String(row.content_hash),
    importedAt: row.imported_at as Date,
    itemsFound: Number(row.items_found),
    itemsAdded: Number(row.items_added),
    itemsUpdated: Number(row.items_updated),
    itemsSkipped: Number(row.items_skipped),
    status: String(row.status) as "completed" | "duplicate" | "failed",
    error: (row.error as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
  };
}

function mapSaved(row: Record<string, unknown>) {
  return {
    id: Number(row.id),
    mediaKey: String(row.media_key),
    href: String(row.href),
    shortcode: (row.shortcode as string | null) ?? null,
    mediaType: String(row.media_type) as "post" | "reel" | "igtv" | "unknown",
    authorUsername: (row.author_username as string | null) ?? null,
    savedAt: (row.saved_at as Date | null)?.toISOString() ?? null,
    firstSeenImportId: Number(row.first_seen_import_id),
    lastSeenImportId: Number(row.last_seen_import_id),
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
    collections: (row.collections as string[]) ?? [],
    membership: { saved: true, liked: Boolean(row.liked) },
  };
}

function mapLiked(row: Record<string, unknown>) {
  return {
    id: Number(row.id),
    mediaKey: String(row.media_key),
    href: String(row.href),
    shortcode: (row.shortcode as string | null) ?? null,
    mediaType: String(row.media_type) as
      | "post"
      | "reel"
      | "igtv"
      | "story"
      | "unknown",
    authorUsername: (row.author_username as string | null) ?? null,
    likedAt: (row.liked_at as Date | null)?.toISOString() ?? null,
    source: String(row.source) as "liked_posts" | "story_likes",
    firstSeenImportId: Number(row.first_seen_import_id),
    lastSeenImportId: Number(row.last_seen_import_id),
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
    alsoSaved: Boolean(row.also_saved),
    membership: { saved: Boolean(row.also_saved), liked: true },
  };
}

async function insertSchema(
  client: PoolClient,
  importId: number,
  entry: FileSchemaCatalogEntry,
) {
  await client.query(
    `INSERT INTO import_schemas(import_id,file_path,byte_size,truncated_read,
     top_level_type,schema_json) VALUES($1,$2,$3,$4,$5,$6)`,
    [
      importId,
      entry.filePath,
      entry.byteSize,
      entry.truncatedRead,
      entry.topLevelType,
      JSON.stringify({
        schema: entry.schema,
        parseError: entry.parseError ?? null,
      }),
    ],
  );
}

async function rollback(pool: Pool, importId: number) {
  const before = await countImportRows(pool, importId);
  const result = await transaction(pool, async (client) => {
    const saves = await client.query(
      "DELETE FROM saved WHERE first_seen_import_id=$1",
      [importId],
    );
    const likes = await client.query(
      "DELETE FROM liked WHERE first_seen_import_id=$1",
      [importId],
    );
    await client.query(
      `DELETE FROM media m WHERE NOT EXISTS
         (SELECT 1 FROM saved s WHERE s.media_id=m.id)
       AND NOT EXISTS (SELECT 1 FROM liked l WHERE l.media_id=m.id)`,
    );
    return {
      savesDeleted: saves.rowCount ?? 0,
      likesDeleted: likes.rowCount ?? 0,
    };
  });
  return { before, ...result, after: await countImportRows(pool, importId) };
}
