import { and, count, desc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "./db";
import { hybridSearchIds, type SearchMode } from "./search/hybrid";
import type { EmbeddingProvider } from "./search/embeddings";
import { parseProviderParam } from "./search/providers";
import { ensureSearchIndexBackfill } from "./search/sync";

const { imports, savedItems, itemCollections } = schema;

let didBackfill = false;

function ensureSearchReady() {
  if (didBackfill) return;
  ensureSearchIndexBackfill();
  didBackfill = true;
}

export function getStats() {
  ensureSearchReady();
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
    importCount: importCount?.total ?? 0,
    topAuthors: topAuthors.map((row) => ({
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
  ensureSearchReady();
  const db = getDb();
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 25));
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

  let itemIdsInCollection: number[] | null = null;
  if (query.collection) {
    itemIdsInCollection = db
      .select({ itemId: itemCollections.itemId })
      .from(itemCollections)
      .where(eq(itemCollections.collectionName, query.collection))
      .all()
      .map((row) => row.itemId);

    if (itemIdsInCollection.length === 0) {
      return {
        items: [],
        total: 0,
        page,
        pageSize,
        totalPages: 0,
        searchMode,
        searchProvider,
        providerFallback,
        providerFallbackReason,
      };
    }

    conditions.push(
      sql`${savedItems.id} in (${sql.join(
        itemIdsInCollection.map((id) => sql`${id}`),
        sql`, `,
      )})`,
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
  ensureSearchReady();
  const db = getDb();
  return db.select().from(imports).orderBy(desc(imports.importedAt)).all();
}

export function getImportById(id: number) {
  ensureSearchReady();
  const db = getDb();
  return db.select().from(imports).where(eq(imports.id, id)).get();
}

export function listFilterOptions() {
  ensureSearchReady();
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
