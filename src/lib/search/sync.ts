import type Database from "better-sqlite3";
import { getSqlite } from "../db";
import { buildSearchDocument, type SearchableItem } from "./document";
import {
  embedText,
  embedTextLocal,
  embeddingConfigForProvider,
  embeddingToBuffer,
  isRemoteEmbeddingConfigured,
  localEmbeddingConfig,
  type EmbeddingConfig,
  type EmbeddingProfile,
  type EmbeddingProvider,
} from "./embeddings";
import {
  configuredProviders,
  configuredRemoteProviders,
  isProviderConfigured,
} from "./providers";

export type RebuildProgress = {
  phase: "preparing" | "fts" | "embedding" | "storing" | "done";
  processed: number;
  total: number;
  currentProvider?: EmbeddingProvider;
  message?: string;
};

export type RebuildProgressCallback = (
  progress: RebuildProgress,
) => void | Promise<void>;

export class RebuildCancelledError extends Error {
  constructor(message = "Reindex cancelled") {
    super(message);
    this.name = "RebuildCancelledError";
  }
}

type SearchRow = SearchableItem & { id: number };
export type VectorIndexName = "local" | "ollama" | "openai" | "voyage";

export type EmbeddingSyncResult = {
  status: "updated" | "skipped";
  items: number;
  providers: string[];
  message: string;
};

const ALL_VECTOR_INDEXES: VectorIndexName[] = [
  "local",
  "ollama",
  "openai",
  "voyage",
];

function vectorTable(index: VectorIndexName): string {
  return `saved_items_vec_${index}`;
}

function allSearchRows(
  sqlite: Database.Database = getSqlite(),
  itemIds?: number[],
): SearchRow[] {
  if (itemIds?.length === 0) return [];
  const where = itemIds
    ? `WHERE si.id IN (${itemIds.map(() => "?").join(", ")})`
    : "";
  return sqlite
    .prepare(
      `SELECT
        si.id,
        si.author_username AS authorUsername,
        si.shortcode AS shortcode,
        si.media_key AS mediaKey,
        si.media_type AS mediaType,
        COALESCE(group_concat(ic.collection_name, char(31)), '') AS collections
      FROM saved_items si
      LEFT JOIN item_collections ic ON ic.item_id = si.id
      ${where}
      GROUP BY si.id`,
    )
    .all(...(itemIds ?? []))
    .map((row) => {
      const typed = row as Omit<SearchRow, "collections"> & {
        collections: string;
      };
      return {
        ...typed,
        collections: typed.collections
          ? typed.collections.split("\u001f").filter(Boolean)
          : [],
      };
    });
}

export function upsertItemFts(
  itemId: number,
  item: SearchableItem,
  sqlite: Database.Database = getSqlite(),
) {
  const doc = buildSearchDocument(item);
  sqlite.prepare(`DELETE FROM saved_items_fts WHERE rowid = ?`).run(itemId);
  sqlite
    .prepare(
      `INSERT INTO saved_items_fts(
        rowid, author_username, shortcode, media_key, media_type, collections
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      itemId,
      doc.authorUsername,
      doc.shortcode,
      doc.mediaKey,
      doc.mediaType,
      doc.collections,
    );
}

export function upsertItemEmbedding(
  index: VectorIndexName,
  itemId: number,
  embedding: Float32Array,
  sqlite: Database.Database = getSqlite(),
) {
  const table = vectorTable(index);
  const id = BigInt(itemId);
  sqlite.prepare(`DELETE FROM ${table} WHERE item_id = ?`).run(id);
  sqlite
    .prepare(`INSERT INTO ${table}(item_id, embedding) VALUES (?, ?)`)
    .run(id, embeddingToBuffer(embedding));
}

export function removeItemSearch(
  itemId: number,
  sqlite: Database.Database = getSqlite(),
) {
  sqlite.prepare(`DELETE FROM saved_items_fts WHERE rowid = ?`).run(itemId);
  for (const index of ALL_VECTOR_INDEXES) {
    if (vectorTableDimensions(index, sqlite) !== null) {
      sqlite
        .prepare(`DELETE FROM ${vectorTable(index)} WHERE item_id = ?`)
        .run(BigInt(itemId));
    }
  }
}

export function ftsCount(sqlite: Database.Database = getSqlite()): number {
  return (
    sqlite.prepare(`SELECT count(*) AS c FROM saved_items_fts`).get() as {
      c: number;
    }
  ).c;
}

export function vecCount(
  index: VectorIndexName,
  sqlite: Database.Database = getSqlite(),
): number {
  if (vectorTableDimensions(index, sqlite) === null) return 0;
  return (
    sqlite
      .prepare(`SELECT count(*) AS c FROM ${vectorTable(index)}`)
      .get() as { c: number }
  ).c;
}

export function vectorTableDimensions(
  index: VectorIndexName,
  sqlite: Database.Database = getSqlite(),
): number | null {
  const row = sqlite
    .prepare(
      `SELECT sql FROM sqlite_master
       WHERE type = 'table' AND name = ?`,
    )
    .get(vectorTable(index)) as { sql: string | null } | undefined;
  const match = row?.sql?.match(/embedding\s+FLOAT\[(\d+)\]/i);
  return match ? Number(match[1]) : null;
}

function recreateVectorTable(
  index: VectorIndexName,
  dimensions: number,
  sqlite: Database.Database,
) {
  const table = vectorTable(index);
  sqlite.exec(`
    DROP TABLE IF EXISTS ${table};
    CREATE VIRTUAL TABLE ${table} USING vec0(
      item_id INTEGER PRIMARY KEY,
      embedding FLOAT[${dimensions}]
    );
  `);
}

export type IndexedEmbeddingProfileMeta = EmbeddingProfile & {
  updatedAt: number;
};

export function getIndexedEmbeddingProfileMeta(
  index: VectorIndexName,
  sqlite: Database.Database = getSqlite(),
): IndexedEmbeddingProfileMeta | null {
  const row = sqlite
    .prepare(
      `SELECT provider, model, dimensions, endpoint, updated_at AS updatedAt
       FROM embedding_index_profiles WHERE index_name = ?`,
    )
    .get(index) as IndexedEmbeddingProfileMeta | undefined;
  return row ?? null;
}

export function getIndexedEmbeddingProfile(
  index: VectorIndexName,
  sqlite: Database.Database = getSqlite(),
): EmbeddingProfile | null {
  const meta = getIndexedEmbeddingProfileMeta(index, sqlite);
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

function writeEmbeddingProfile(
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
      index,
      profile.provider,
      profile.model,
      profile.dimensions,
      profile.endpoint,
    );
}

export function vectorIndexMatchesConfig(
  index: VectorIndexName,
  config: EmbeddingConfig,
  sqlite: Database.Database = getSqlite(),
): boolean {
  const indexed = getIndexedEmbeddingProfile(index, sqlite);
  return Boolean(
    indexed &&
      vecCount(index, sqlite) > 0 &&
      vectorTableDimensions(index, sqlite) === config.profile.dimensions &&
      embeddingProfilesMatch(indexed, config.profile),
  );
}

async function generateEmbeddings(rows: SearchRow[], config: EmbeddingConfig) {
  const generated: Array<{ id: number; embedding: Float32Array }> = [];
  for (const row of rows) {
    generated.push({
      id: row.id,
      embedding: await embedText(buildSearchDocument(row).combined, config),
    });
  }
  return generated;
}

function storeEmbeddings(
  index: VectorIndexName,
  generated: Array<{ id: number; embedding: Float32Array }>,
  config: EmbeddingConfig,
  replace: boolean,
  sqlite: Database.Database,
) {
  sqlite.transaction(() => {
    if (
      replace ||
      vectorTableDimensions(index, sqlite) !== config.profile.dimensions
    ) {
      recreateVectorTable(index, config.profile.dimensions, sqlite);
    }
    for (const result of generated) {
      upsertItemEmbedding(index, result.id, result.embedding, sqlite);
    }
    writeEmbeddingProfile(index, config.profile, sqlite);
  })();
}

function canExtendRemoteIndex(
  provider: EmbeddingProvider,
  config: EmbeddingConfig,
  rows: SearchRow[],
  sqlite: Database.Database,
): boolean {
  const indexed = getIndexedEmbeddingProfile(provider, sqlite);
  const totalItems = (
    sqlite.prepare(`SELECT count(*) AS c FROM saved_items`).get() as {
      c: number;
    }
  ).c;
  return (
    totalItems === rows.length ||
    Boolean(
      indexed &&
        embeddingProfilesMatch(indexed, config.profile) &&
        vectorTableDimensions(provider, sqlite) ===
          config.profile.dimensions &&
        vecCount(provider, sqlite) >= totalItems - rows.length,
    )
  );
}

async function syncProviderIndex(
  provider: EmbeddingProvider,
  rows: SearchRow[],
  replace: boolean,
  sqlite: Database.Database,
): Promise<{ updated: boolean; error?: string }> {
  const config = embeddingConfigForProvider(provider);
  if (provider === "local") {
    const generated = await generateEmbeddings(rows, config);
    storeEmbeddings("local", generated, config, replace, sqlite);
    return { updated: true };
  }

  // Cloud providers need a real key; Ollama accepts a dummy bearer token.
  if (provider !== "ollama" && !config.apiKey) return { updated: false };

  if (!replace && !canExtendRemoteIndex(provider, config, rows, sqlite)) {
    return {
      updated: false,
      error: `${provider} index provenance differs or is incomplete`,
    };
  }

  try {
    const generated = await generateEmbeddings(rows, config);
    storeEmbeddings(provider, generated, config, replace, sqlite);
    return { updated: true };
  } catch (error) {
    return {
      updated: false,
      error: error instanceof Error ? error.message : "unknown error",
    };
  }
}

/**
 * Updates vector indexes only for explicitly enabled providers.
 * Disabled indexes are skipped even when API keys exist.
 * Network work for remotes runs outside long SQLite transactions.
 */
export async function syncItemEmbeddings(
  itemIds: number[],
): Promise<EmbeddingSyncResult> {
  const uniqueIds = [...new Set(itemIds)];
  const sqlite = getSqlite();
  const rows = allSearchRows(sqlite, uniqueIds);
  const updatedProviders: string[] = [];
  const notes: string[] = [];
  const targets = configuredProviders();

  for (const provider of targets) {
    const result = await syncProviderIndex(provider, rows, false, sqlite);
    if (result.updated) {
      updatedProviders.push(provider);
    } else if (result.error) {
      notes.push(`${provider}: ${result.error}`);
    }
  }

  if (rows.length === 0) {
    return {
      status: "updated",
      items: 0,
      providers: updatedProviders,
      message: "No changed items needed semantic indexing.",
    };
  }

  if (targets.length === 0) {
    return {
      status: "skipped",
      items: rows.length,
      providers: [],
      message:
        "No embedding indexes are enabled — keyword (FTS) search still works. Enable providers in Settings.",
    };
  }

  const remoteConfigured = configuredRemoteProviders();
  const remoteUpdated = remoteConfigured.filter((p) =>
    updatedProviders.includes(p),
  );
  const skippedRemote = remoteConfigured.filter(
    (p) => !updatedProviders.includes(p),
  );
  const localUpdated = updatedProviders.includes("local");

  let message = localUpdated
    ? `Offline semantic index updated for ${rows.length} item${rows.length === 1 ? "" : "s"}`
    : `Semantic indexing for ${rows.length} item${rows.length === 1 ? "" : "s"}`;
  if (remoteUpdated.length > 0) {
    message += `; ${remoteUpdated.join(", ")} indexes updated`;
  }
  if (skippedRemote.length > 0) {
    message += `; ${skippedRemote.join(", ")} skipped (${notes.join("; ") || "run pnpm run reindex"})`;
  }
  if (!localUpdated && remoteUpdated.length === 0 && skippedRemote.length === 0) {
    message += " (no enabled indexes updated)";
  }
  message += ".";

  return {
    status:
      skippedRemote.length > 0 && remoteUpdated.length === 0 && !localUpdated
        ? "skipped"
        : "updated",
    items: rows.length,
    providers: updatedProviders,
    message,
  };
}

function assertProviderRebuildable(provider: EmbeddingProvider) {
  if (!isProviderConfigured(provider)) {
    throw new Error(
      `${provider} is not enabled — turn it on in Settings (and add credentials if needed) before reindexing`,
    );
  }
  if (provider !== "local" && provider !== "ollama") {
    const config = embeddingConfigForProvider(provider);
    if (!config.apiKey) {
      throw new Error(`${provider} API key is missing`);
    }
  }
}

async function emitProgress(
  onProgress: RebuildProgressCallback | undefined,
  progress: RebuildProgress,
) {
  await onProgress?.(progress);
}

function throwIfCancelled(shouldCancel?: () => boolean) {
  if (shouldCancel?.()) throw new RebuildCancelledError();
}

/**
 * Rebuild a single provider's vector index with incremental progress.
 * Embedding network calls never run inside a SQLite write transaction.
 */
export async function rebuildProviderIndex(
  provider: EmbeddingProvider,
  options?: {
    onProgress?: RebuildProgressCallback;
    shouldCancel?: () => boolean;
  },
): Promise<{ items: number }> {
  assertProviderRebuildable(provider);

  const sqlite = getSqlite();
  const rows = allSearchRows(sqlite);
  const config = embeddingConfigForProvider(provider);
  const total = rows.length;
  const onProgress = options?.onProgress;
  const shouldCancel = options?.shouldCancel;

  await emitProgress(onProgress, {
    phase: "preparing",
    processed: 0,
    total,
    currentProvider: provider,
    message: `Preparing ${provider} index…`,
  });
  throwIfCancelled(shouldCancel);

  // Recreate the empty table in a short transaction before any network work.
  sqlite.transaction(() => {
    recreateVectorTable(provider, config.profile.dimensions, sqlite);
  })();

  let processed = 0;
  for (const row of rows) {
    throwIfCancelled(shouldCancel);
    await emitProgress(onProgress, {
      phase: "embedding",
      processed,
      total,
      currentProvider: provider,
      message: `Embedding ${provider} ${processed + 1}/${total}…`,
    });

    const embedding = await embedText(
      buildSearchDocument(row).combined,
      config,
    );

    throwIfCancelled(shouldCancel);

    // Short write only — never held across embedText/network.
    sqlite.transaction(() => {
      upsertItemEmbedding(provider, row.id, embedding, sqlite);
    })();

    processed += 1;
    await emitProgress(onProgress, {
      phase: "embedding",
      processed,
      total,
      currentProvider: provider,
      message: `Embedded ${provider} ${processed}/${total}`,
    });
  }

  sqlite.transaction(() => {
    writeEmbeddingProfile(provider, config.profile, sqlite);
  })();

  await emitProgress(onProgress, {
    phase: "done",
    processed,
    total,
    currentProvider: provider,
    message: `${provider} index rebuilt (${processed} items)`,
  });

  return { items: processed };
}

/**
 * Rebuild FTS, then every enabled (+ credentialed) provider.
 * Network calls never hold a transaction.
 */
export async function rebuildConfiguredIndexes(options?: {
  onProgress?: RebuildProgressCallback;
  shouldCancel?: () => boolean;
  requireRemote?: boolean;
}): Promise<{
  items: number;
  providers: string[];
  remoteUpdated: string[];
}> {
  if (options?.requireRemote && !isRemoteEmbeddingConfigured()) {
    throw new Error(
      "--remote requires at least one enabled neural provider (OpenAI/Voyage with keys, and/or Ollama)",
    );
  }

  const sqlite = getSqlite();
  const rows = allSearchRows(sqlite);
  const onProgress = options?.onProgress;
  const shouldCancel = options?.shouldCancel;
  const total = rows.length;
  const providers = configuredProviders();

  await emitProgress(onProgress, {
    phase: "fts",
    processed: 0,
    total: Math.max(1, total * Math.max(1, providers.length)),
    message: "Rebuilding keyword (FTS) index…",
  });
  throwIfCancelled(shouldCancel);

  sqlite.transaction(() => {
    sqlite.exec(`DELETE FROM saved_items_fts`);
    for (const row of rows) upsertItemFts(row.id, row, sqlite);
  })();

  const remoteUpdated: string[] = [];
  const overallTotal = Math.max(1, total * Math.max(1, providers.length));
  let overallBase = 0;

  for (const provider of providers) {
    throwIfCancelled(shouldCancel);
    await rebuildProviderIndex(provider, {
      onProgress: async (progress) => {
        await emitProgress(onProgress, {
          ...progress,
          processed: overallBase + progress.processed,
          total: overallTotal,
        });
      },
      shouldCancel,
    });
    overallBase += total;
    if (provider !== "local") remoteUpdated.push(provider);
  }

  await emitProgress(onProgress, {
    phase: "done",
    processed: overallTotal,
    total: overallTotal,
    message: `Rebuilt FTS and ${providers.join(", ")}`,
  });

  return {
    items: total,
    providers,
    remoteUpdated,
  };
}

/**
 * Rebuild FTS, then every enabled provider index.
 * Network calls never hold a transaction.
 */
export async function rebuildSearchIndex(options?: {
  requireRemote?: boolean;
  onProgress?: RebuildProgressCallback;
  shouldCancel?: () => boolean;
}): Promise<{
  items: number;
  providers: string[];
  remoteUpdated: string[];
}> {
  return rebuildConfiguredIndexes(options);
}

/** Backfill keyword index; local vectors only when the local index is enabled. */
export function ensureSearchIndexBackfill() {
  const sqlite = getSqlite();
  const rows = allSearchRows(sqlite);
  if (rows.length === 0) return;

  if (ftsCount(sqlite) < rows.length) {
    sqlite.transaction(() => {
      for (const row of rows) upsertItemFts(row.id, row, sqlite);
    })();
  }

  if (!isProviderConfigured("local")) return;

  const localConfig = localEmbeddingConfig();
  if (
    vecCount("local", sqlite) >= rows.length &&
    vectorIndexMatchesConfig("local", localConfig, sqlite)
  ) {
    return;
  }

  const generated = rows.map((row) => ({
    id: row.id,
    embedding: embedTextLocal(
      buildSearchDocument(row).combined,
      localConfig.profile.dimensions,
    ),
  }));
  storeEmbeddings("local", generated, localConfig, true, sqlite);
}
