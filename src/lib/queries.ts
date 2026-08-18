import { and, count, desc, eq, sql } from "drizzle-orm";
import { getDb, getSqlite, schema } from "./db";
import {
  hybridSearchIds,
  hybridSearchLikedIds,
  type SearchMode,
} from "./search/hybrid";
import type { EmbeddingProvider } from "./search/embeddings";
import { parseProviderParam } from "./search/providers";

const { imports, savedItems, itemCollections, likedItems } = schema;

/**
 * Browse / stats / list are read-only. Search index gaps are healed via
 * embedding jobs scheduled from Indexes status (see search/readiness.ts),
 * not by synchronous ensureSearchIndexBackfill on GET.
 */

export function getStats() {
  const db = getDb();

  const totals = db
    .select({
      total: count(),
      posts: sql<number>`sum(case when ${savedItems.mediaType} = 'post' then 1 else 0 end)`,
      reels: sql<number>`sum(case when ${savedItems.mediaType} = 'reel' then 1 else 0 end)`,
      authors: sql<number>`count(distinct ${savedItems.authorUsername})`,
    })
    .from(savedItems)
    .get();

  const likesTotals = db
    .select({
      total: count(),
      posts: sql<number>`sum(case when ${likedItems.mediaType} = 'post' then 1 else 0 end)`,
      reels: sql<number>`sum(case when ${likedItems.mediaType} = 'reel' then 1 else 0 end)`,
      stories: sql<number>`sum(case when ${likedItems.mediaType} = 'story' then 1 else 0 end)`,
      comments: sql<number>`sum(case when ${likedItems.mediaType} = 'comment' then 1 else 0 end)`,
    })
    .from(likedItems)
    .get();

  const importCount = db.select({ total: count() }).from(imports).get();

  const topAuthors = db
    .select({
      authorUsername: savedItems.authorUsername,
      total: count(),
    })
    .from(savedItems)
    .where(sql`${savedItems.authorUsername} is not null`)
    .groupBy(savedItems.authorUsername)
    .orderBy(desc(count()))
    .limit(10)
    .all();

  const topLikedAuthors = db
    .select({
      authorUsername: likedItems.authorUsername,
      total: count(),
    })
    .from(likedItems)
    .where(sql`${likedItems.authorUsername} is not null`)
    .groupBy(likedItems.authorUsername)
    .orderBy(desc(count()))
    .limit(10)
    .all();

  const collections = db
    .select({
      collectionName: itemCollections.collectionName,
      total: count(),
    })
    .from(itemCollections)
    .groupBy(itemCollections.collectionName)
    .orderBy(desc(count()))
    .limit(12)
    .all();

  const recentImports = db
    .select()
    .from(imports)
    .orderBy(desc(imports.importedAt))
    .limit(5)
    .all();

  return {
    totalItems: totals?.total ?? 0,
    posts: Number(totals?.posts ?? 0),
    reels: Number(totals?.reels ?? 0),
    authors: Number(totals?.authors ?? 0),
    totalLikes: likesTotals?.total ?? 0,
    likedPosts: Number(likesTotals?.posts ?? 0),
    likedReels: Number(likesTotals?.reels ?? 0),
    likedStories: Number(likesTotals?.stories ?? 0),
    likedComments: Number(likesTotals?.comments ?? 0),
    importCount: importCount?.total ?? 0,
    topAuthors: topAuthors.map((row) => ({
      authorUsername: row.authorUsername ?? "unknown",
      total: row.total,
    })),
    topLikedAuthors: topLikedAuthors.map((row) => ({
      authorUsername: row.authorUsername ?? "unknown",
      total: row.total,
    })),
    collections: collections.map((row) => ({
      collectionName: row.collectionName,
      total: row.total,
    })),
    recentImports,
  };
}

export type SavesQuery = {
  q?: string;
  type?: string;
  author?: string;
  collection?: string;
  page?: number;
  pageSize?: number;
  provider?: string;
};

export async function listSaves(query: SavesQuery) {
  const db = getDb();
  const pageRaw = query.page ?? 1;
  const pageSizeRaw = query.pageSize ?? 25;
  const page =
    Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1;
  const pageSize =
    Number.isFinite(pageSizeRaw) && pageSizeRaw >= 1
      ? Math.min(100, Math.floor(pageSizeRaw))
      : 25;
  const offset = (page - 1) * pageSize;

  const conditions = [];
  let searchMode: SearchMode | "like" = "none";
  let searchProvider: EmbeddingProvider | null = null;
  let providerFallback = false;
  let providerFallbackReason: string | undefined;
  let rankedIds: number[] | null = null;

  if (query.q?.trim()) {
    const requestedProvider = parseProviderParam(query.provider);
    const {
      hits,
      mode,
      provider,
      providerFallback: fallback,
      providerFallbackReason: fallbackReason,
    } = await hybridSearchIds(query.q.trim(), 500, requestedProvider);
    searchProvider = provider;
    providerFallback = fallback;
    providerFallbackReason = fallbackReason;
    if (hits.length > 0) {
      rankedIds = hits.map((hit) => hit.id);
      searchMode = mode;
      conditions.push(
        sql`${savedItems.id} in (${sql.join(
          rankedIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      );
    } else {
      // Fallback LIKE if FTS/vec miss (e.g. partial media keys).
      const term = `%${query.q.trim()}%`;
      searchMode = "like";
      conditions.push(
        sql`(
          ${savedItems.authorUsername} like ${term}
          or ${savedItems.href} like ${term}
          or ${savedItems.shortcode} like ${term}
          or ${savedItems.mediaKey} like ${term}
        )`,
      );
    }
  }

  if (query.type && query.type !== "all") {
    conditions.push(
      eq(
        savedItems.mediaType,
        query.type as "post" | "reel" | "igtv" | "unknown",
      ),
    );
  }

  if (query.author) {
    conditions.push(eq(savedItems.authorUsername, query.author));
  }

  if (query.collection) {
    // Subquery / EXISTS avoids materializing huge bound IN() lists (SQLite
    // variable limits) when a collection has tens of thousands of members.
    conditions.push(
      sql`exists (
        select 1 from ${itemCollections}
        where ${itemCollections.itemId} = ${savedItems.id}
          and ${itemCollections.collectionName} = ${query.collection}
      )`,
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const totalRow = db
    .select({ total: count() })
    .from(savedItems)
    .where(where)
    .get();

  let rows;
  if (rankedIds && rankedIds.length > 0) {
    // Preserve hybrid RRF order, then paginate in JS after filter.
    const filtered = db.select().from(savedItems).where(where).all();
    const byId = new Map(filtered.map((row) => [row.id, row]));
    const ordered = rankedIds
      .map((id) => byId.get(id))
      .filter((row): row is NonNullable<typeof row> => Boolean(row));
    rows = ordered.slice(offset, offset + pageSize);
  } else {
    rows = db
      .select()
      .from(savedItems)
      .where(where)
      .orderBy(desc(savedItems.savedAt), desc(savedItems.id))
      .limit(pageSize)
      .offset(offset)
      .all();
  }

  const ids = rows.map((row) => row.id);
  const collectionRows =
    ids.length === 0
      ? []
      : db
          .select()
          .from(itemCollections)
          .where(
            sql`${itemCollections.itemId} in (${sql.join(
              ids.map((id) => sql`${id}`),
              sql`, `,
            )})`,
          )
          .all();

  const collectionsByItem = new Map<number, string[]>();
  for (const row of collectionRows) {
    const list = collectionsByItem.get(row.itemId) ?? [];
    list.push(row.collectionName);
    collectionsByItem.set(row.itemId, list);
  }

  const total = totalRow?.total ?? 0;

  return {
    items: rows.map((row) => ({
      ...row,
      savedAt: row.savedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      collections: collectionsByItem.get(row.id) ?? [],
    })),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
    searchMode,
    searchProvider,
    providerFallback,
    providerFallbackReason,
  };
}

export function listImports() {
  const db = getDb();
  return db.select().from(imports).orderBy(desc(imports.importedAt)).all();
}

export function getImportById(id: number) {
  const db = getDb();
  return db.select().from(imports).where(eq(imports.id, id)).get();
}

export function listFilterOptions() {
  const db = getDb();

  const authors = db
    .selectDistinct({ authorUsername: savedItems.authorUsername })
    .from(savedItems)
    .where(sql`${savedItems.authorUsername} is not null`)
    .orderBy(savedItems.authorUsername)
    .all()
    .map((row) => row.authorUsername!)
    .filter(Boolean);

  const collections = db
    .selectDistinct({ collectionName: itemCollections.collectionName })
    .from(itemCollections)
    .orderBy(itemCollections.collectionName)
    .all()
    .map((row) => row.collectionName);

  return { authors, collections };
}

export type LikesQuery = {
  q?: string;
  type?: string;
  author?: string;
  page?: number;
  pageSize?: number;
  provider?: string;
};

function savedKeysForLikePage(
  rows: Array<{ mediaKey: string; shortcode: string | null }>,
): Set<string> {
  if (rows.length === 0) return new Set();
  const sqlite = getSqlite();
  const mediaKeys = [...new Set(rows.map((row) => row.mediaKey))];
  const shortcodes = [
    ...new Set(
      rows
        .map((row) => row.shortcode)
        .filter((value): value is string => Boolean(value)),
    ),
  ];

  const matched = new Set<string>();

  if (mediaKeys.length > 0) {
    const keyRows = sqlite
      .prepare(
        `SELECT media_key AS mediaKey
         FROM saved_items
         WHERE media_key IN (${mediaKeys.map(() => "?").join(", ")})`,
      )
      .all(...mediaKeys) as Array<{ mediaKey: string }>;
    for (const row of keyRows) matched.add(`key:${row.mediaKey}`);
  }

  if (shortcodes.length > 0) {
    const codeRows = sqlite
      .prepare(
        `SELECT shortcode AS shortcode
         FROM saved_items
         WHERE shortcode IN (${shortcodes.map(() => "?").join(", ")})`,
      )
      .all(...shortcodes) as Array<{ shortcode: string }>;
    for (const row of codeRows) matched.add(`code:${row.shortcode}`);
  }

  return matched;
}

export async function listLikes(query: LikesQuery) {
  const db = getDb();
  const pageRaw = query.page ?? 1;
  const pageSizeRaw = query.pageSize ?? 25;
  const page =
    Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1;
  const pageSize =
    Number.isFinite(pageSizeRaw) && pageSizeRaw >= 1
      ? Math.min(100, Math.floor(pageSizeRaw))
      : 25;
  const offset = (page - 1) * pageSize;

  const conditions = [];
  let searchMode: SearchMode | "like" = "none";
  let searchProvider: EmbeddingProvider | null = null;
  let providerFallback = false;
  let providerFallbackReason: string | undefined;
  let rankedIds: number[] | null = null;

  if (query.q?.trim()) {
    const requestedProvider = parseProviderParam(query.provider);
    const {
      hits,
      mode,
      provider,
      providerFallback: fallback,
      providerFallbackReason: fallbackReason,
    } = await hybridSearchLikedIds(query.q.trim(), 500, requestedProvider);
    searchProvider = provider;
    providerFallback = fallback;
    providerFallbackReason = fallbackReason;
    if (hits.length > 0) {
      rankedIds = hits.map((hit) => hit.id);
      searchMode = mode;
      conditions.push(
        sql`${likedItems.id} in (${sql.join(
          rankedIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      );
    } else {
      const term = `%${query.q.trim()}%`;
      searchMode = "like";
      conditions.push(
        sql`(
          ${likedItems.authorUsername} like ${term}
          or ${likedItems.href} like ${term}
          or ${likedItems.shortcode} like ${term}
          or ${likedItems.mediaKey} like ${term}
        )`,
      );
    }
  }

  if (query.type && query.type !== "all") {
    conditions.push(
      eq(
        likedItems.mediaType,
        query.type as
          | "post"
          | "reel"
          | "igtv"
          | "story"
          | "comment"
          | "unknown",
      ),
    );
  }

  if (query.author) {
    conditions.push(eq(likedItems.authorUsername, query.author));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const totalRow = db
    .select({ total: count() })
    .from(likedItems)
    .where(where)
    .get();

  let rows;
  if (rankedIds && rankedIds.length > 0) {
    const filtered = db.select().from(likedItems).where(where).all();
    const byId = new Map(filtered.map((row) => [row.id, row]));
    const ordered = rankedIds
      .map((id) => byId.get(id))
      .filter((row): row is NonNullable<typeof row> => Boolean(row));
    rows = ordered.slice(offset, offset + pageSize);
  } else {
    rows = db
      .select()
      .from(likedItems)
      .where(where)
      .orderBy(desc(likedItems.likedAt), desc(likedItems.id))
      .limit(pageSize)
      .offset(offset)
      .all();
  }

  const savedMatches = savedKeysForLikePage(rows);
  const total = totalRow?.total ?? 0;

  return {
    items: rows.map((row) => {
      const alsoSaved =
        savedMatches.has(`key:${row.mediaKey}`) ||
        Boolean(row.shortcode && savedMatches.has(`code:${row.shortcode}`));
      return {
        ...row,
        likedAt: row.likedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        alsoSaved,
      };
    }),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
    searchMode,
    searchProvider,
    providerFallback,
    providerFallbackReason,
  };
}

export function listLikesFilterOptions() {
  const db = getDb();

  const authors = db
    .selectDistinct({ authorUsername: likedItems.authorUsername })
    .from(likedItems)
    .where(sql`${likedItems.authorUsername} is not null`)
    .orderBy(likedItems.authorUsername)
    .all()
    .map((row) => row.authorUsername!)
    .filter(Boolean);

  return { authors };
}
