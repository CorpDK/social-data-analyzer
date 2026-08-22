import { and, count, desc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "./db";
import {
  BROWSE_HYBRID_SEARCH_LIMIT,
  hybridSearchIds,
  hybridSearchLikedIds,
  type SearchMode,
} from "./search/hybrid";
import type { EmbeddingProvider } from "./search/embeddings";
import { parseProviderParam } from "./search/providers";

const { imports, media, saved, itemCollections, liked } = schema;

const mediaSelection = {
  id: media.id,
  mediaKey: media.mediaKey,
  href: media.href,
  shortcode: media.shortcode,
  mediaType: media.mediaType,
  authorUsername: media.authorUsername,
  createdAt: media.createdAt,
  updatedAt: media.updatedAt,
};

export { BROWSE_HYBRID_SEARCH_LIMIT };

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
      posts: sql<number>`sum(case when ${media.mediaType} = 'post' then 1 else 0 end)`,
      reels: sql<number>`sum(case when ${media.mediaType} = 'reel' then 1 else 0 end)`,
      authors: sql<number>`count(distinct ${media.authorUsername})`,
    })
    .from(saved)
    .innerJoin(media, eq(media.id, saved.mediaId))
    .get();

  const likesTotals = db
    .select({
      total: count(),
      posts: sql<number>`sum(case when ${media.mediaType} = 'post' then 1 else 0 end)`,
      reels: sql<number>`sum(case when ${media.mediaType} = 'reel' then 1 else 0 end)`,
      stories: sql<number>`sum(case when ${media.mediaType} = 'story' then 1 else 0 end)`,
      comments: sql<number>`0`,
    })
    .from(liked)
    .innerJoin(media, eq(media.id, liked.mediaId))
    .get();

  const importCount = db.select({ total: count() }).from(imports).get();

  const topAuthors = db
    .select({
      authorUsername: media.authorUsername,
      total: count(),
    })
    .from(saved)
    .innerJoin(media, eq(media.id, saved.mediaId))
    .where(sql`${media.authorUsername} is not null`)
    .groupBy(media.authorUsername)
    .orderBy(desc(count()))
    .limit(10)
    .all();

  const topLikedAuthors = db
    .select({
      authorUsername: media.authorUsername,
      total: count(),
    })
    .from(liked)
    .innerJoin(media, eq(media.id, liked.mediaId))
    .where(sql`${media.authorUsername} is not null`)
    .groupBy(media.authorUsername)
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
  let totalCapped = false;

  if (query.q?.trim()) {
    const requestedProvider = parseProviderParam(query.provider);
    const {
      hits,
      mode,
      provider,
      providerFallback: fallback,
      providerFallbackReason: fallbackReason,
      truncated,
    } = await hybridSearchIds(
      query.q.trim(),
      BROWSE_HYBRID_SEARCH_LIMIT,
      requestedProvider,
    );
    searchProvider = provider;
    providerFallback = fallback;
    providerFallbackReason = fallbackReason;
    totalCapped = Boolean(truncated);
    if (hits.length > 0) {
      rankedIds = hits.map((hit) => hit.id);
      searchMode = mode;
      conditions.push(
        sql`${media.id} in (${sql.join(
          rankedIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      );
    } else {
      // Fallback LIKE if FTS/vec miss (e.g. partial media keys).
      const term = `%${query.q.trim()}%`;
      searchMode = "like";
      totalCapped = false;
      conditions.push(
        sql`(
          ${media.authorUsername} like ${term}
          or ${media.href} like ${term}
          or ${media.shortcode} like ${term}
          or ${media.mediaKey} like ${term}
        )`,
      );
    }
  }

  if (query.type && query.type !== "all") {
    conditions.push(
      eq(
        media.mediaType,
        query.type as "post" | "reel" | "igtv" | "unknown",
      ),
    );
  }

  if (query.author) {
    conditions.push(eq(media.authorUsername, query.author));
  }

  if (query.collection) {
    // Subquery / EXISTS avoids materializing huge bound IN() lists (SQLite
    // variable limits) when a collection has tens of thousands of members.
    conditions.push(
      sql`exists (
        select 1 from ${itemCollections}
        where ${itemCollections.itemId} = ${media.id}
          and ${itemCollections.collectionName} = ${query.collection}
      )`,
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const totalRow = db
    .select({ total: count() })
    .from(saved)
    .innerJoin(media, eq(media.id, saved.mediaId))
    .where(where)
    .get();

  let rows;
  if (rankedIds && rankedIds.length > 0) {
    // Preserve hybrid RRF order, then paginate in JS after filter.
    const filtered = db
      .select({
        ...mediaSelection,
        savedAt: saved.savedAt,
        firstSeenImportId: saved.firstSeenImportId,
        lastSeenImportId: saved.lastSeenImportId,
        liked: sql<boolean>`exists(select 1 from liked where liked.media_id = ${media.id})`,
      })
      .from(saved)
      .innerJoin(media, eq(media.id, saved.mediaId))
      .where(where)
      .all();
    const byId = new Map(filtered.map((row) => [row.id, row]));
    const ordered = rankedIds
      .map((id) => byId.get(id))
      .filter((row): row is NonNullable<typeof row> => Boolean(row));
    rows = ordered.slice(offset, offset + pageSize);
  } else {
    rows = db
      .select({
        ...mediaSelection,
        savedAt: saved.savedAt,
        firstSeenImportId: saved.firstSeenImportId,
        lastSeenImportId: saved.lastSeenImportId,
        liked: sql<boolean>`exists(select 1 from liked where liked.media_id = ${media.id})`,
      })
      .from(saved)
      .innerJoin(media, eq(media.id, saved.mediaId))
      .where(where)
      .orderBy(desc(saved.savedAt), desc(media.id))
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
    items: rows.map((row) => {
      const { liked: isLiked, ...item } = row;
      return {
        ...item,
        savedAt: row.savedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        collections: collectionsByItem.get(row.id) ?? [],
        membership: { saved: true, liked: Boolean(isLiked) },
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
    totalCapped,
    searchCap: query.q?.trim() ? BROWSE_HYBRID_SEARCH_LIMIT : undefined,
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

/** Distinct authors/collections for Saves browse filter dropdowns. */
export function listSavesFilterOptions() {
  const db = getDb();

  const authors = db
    .selectDistinct({ authorUsername: media.authorUsername })
    .from(saved)
    .innerJoin(media, eq(media.id, saved.mediaId))
    .where(sql`${media.authorUsername} is not null`)
    .orderBy(media.authorUsername)
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

/** Alias used by `GET /api/imports` (nested `filters` next to import history). */
export const listFilterOptions = listSavesFilterOptions;

export type LikesQuery = {
  q?: string;
  type?: string;
  author?: string;
  page?: number;
  pageSize?: number;
  provider?: string;
};

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
  let totalCapped = false;

  if (query.q?.trim()) {
    const requestedProvider = parseProviderParam(query.provider);
    const {
      hits,
      mode,
      provider,
      providerFallback: fallback,
      providerFallbackReason: fallbackReason,
      truncated,
    } = await hybridSearchLikedIds(
      query.q.trim(),
      BROWSE_HYBRID_SEARCH_LIMIT,
      requestedProvider,
    );
    searchProvider = provider;
    providerFallback = fallback;
    providerFallbackReason = fallbackReason;
    totalCapped = Boolean(truncated);
    if (hits.length > 0) {
      rankedIds = hits.map((hit) => hit.id);
      searchMode = mode;
      conditions.push(
        sql`${media.id} in (${sql.join(
          rankedIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      );
    } else {
      const term = `%${query.q.trim()}%`;
      searchMode = "like";
      totalCapped = false;
      conditions.push(
        sql`(
          ${media.authorUsername} like ${term}
          or ${media.href} like ${term}
          or ${media.shortcode} like ${term}
          or ${media.mediaKey} like ${term}
        )`,
      );
    }
  }

  if (query.type && query.type !== "all") {
    conditions.push(
      eq(
        media.mediaType,
        query.type as
          | "post"
          | "reel"
          | "igtv"
          | "story"
          | "unknown",
      ),
    );
  }

  if (query.author) {
    conditions.push(eq(media.authorUsername, query.author));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const totalRow = db
    .select({ total: count() })
    .from(liked)
    .innerJoin(media, eq(media.id, liked.mediaId))
    .where(where)
    .get();

  let rows;
  if (rankedIds && rankedIds.length > 0) {
    const filtered = db
      .select({
        ...mediaSelection,
        likedAt: liked.likedAt,
        source: liked.source,
        firstSeenImportId: liked.firstSeenImportId,
        lastSeenImportId: liked.lastSeenImportId,
        saved: sql<boolean>`exists(select 1 from saved where saved.media_id = ${media.id})`,
      })
      .from(liked)
      .innerJoin(media, eq(media.id, liked.mediaId))
      .where(where)
      .all();
    const byId = new Map(filtered.map((row) => [row.id, row]));
    const ordered = rankedIds
      .map((id) => byId.get(id))
      .filter((row): row is NonNullable<typeof row> => Boolean(row));
    rows = ordered.slice(offset, offset + pageSize);
  } else {
    rows = db
      .select({
        ...mediaSelection,
        likedAt: liked.likedAt,
        source: liked.source,
        firstSeenImportId: liked.firstSeenImportId,
        lastSeenImportId: liked.lastSeenImportId,
        saved: sql<boolean>`exists(select 1 from saved where saved.media_id = ${media.id})`,
      })
      .from(liked)
      .innerJoin(media, eq(media.id, liked.mediaId))
      .where(where)
      .orderBy(desc(liked.likedAt), desc(media.id))
      .limit(pageSize)
      .offset(offset)
      .all();
  }

  const total = totalRow?.total ?? 0;

  return {
    items: rows.map((row) => {
      const { saved: isSaved, ...item } = row;
      return {
        ...item,
        likedAt: row.likedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        alsoSaved: Boolean(isSaved),
        membership: { saved: Boolean(isSaved), liked: true },
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
    totalCapped,
    searchCap: query.q?.trim() ? BROWSE_HYBRID_SEARCH_LIMIT : undefined,
  };
}

export function listLikesFilterOptions() {
  const db = getDb();

  const authors = db
    .selectDistinct({ authorUsername: media.authorUsername })
    .from(liked)
    .innerJoin(media, eq(media.id, liked.mediaId))
    .where(sql`${media.authorUsername} is not null`)
    .orderBy(media.authorUsername)
    .all()
    .map((row) => row.authorUsername!)
    .filter(Boolean);

  return { authors };
}
