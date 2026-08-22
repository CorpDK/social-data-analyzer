/**
 * SQLite plain-table schema.
 *
 * Drizzle Kit owns every ordinary table and index in this file. FTS5 and vec0
 * virtual tables stay in `src/lib/db/ddl.ts`.
 */
import { relations, sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const unixepoch = sql`(unixepoch())`;

export const imports = sqliteTable(
  "imports",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    filename: text("filename").notNull(),
    contentHash: text("content_hash").notNull(),
    importedAt: integer("imported_at", { mode: "timestamp" })
      .notNull()
      .default(unixepoch),
    itemsFound: integer("items_found").notNull().default(0),
    itemsAdded: integer("items_added").notNull().default(0),
    itemsUpdated: integer("items_updated").notNull().default(0),
    itemsSkipped: integer("items_skipped").notNull().default(0),
    status: text("status", {
      enum: ["completed", "duplicate", "failed"],
    })
      .notNull()
      .default("completed"),
    error: text("error"),
    notes: text("notes"),
  },
  (table) => [index("imports_content_hash_idx").on(table.contentHash)],
);

export const media = sqliteTable(
  "media",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    mediaKey: text("media_key").notNull(),
    href: text("href").notNull(),
    shortcode: text("shortcode"),
    mediaType: text("media_type", {
      enum: ["post", "reel", "igtv", "story", "unknown"],
    })
      .notNull()
      .default("unknown"),
    authorUsername: text("author_username"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(unixepoch),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(unixepoch),
  },
  (table) => [
    uniqueIndex("media_media_key_uidx").on(table.mediaKey),
    index("media_author_idx").on(table.authorUsername),
    index("media_type_idx").on(table.mediaType),
  ],
);

export const saved = sqliteTable(
  "saved",
  {
    mediaId: integer("media_id")
      .primaryKey()
      .references(() => media.id, { onDelete: "cascade" }),
    savedAt: integer("saved_at", { mode: "timestamp" }),
    firstSeenImportId: integer("first_seen_import_id")
      .notNull()
      .references(() => imports.id),
    lastSeenImportId: integer("last_seen_import_id")
      .notNull()
      .references(() => imports.id),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(unixepoch),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(unixepoch),
  },
  (table) => [index("saved_saved_at_idx").on(table.savedAt)],
);

export const itemCollections = sqliteTable(
  "item_collections",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    itemId: integer("item_id")
      .notNull()
      .references(() => saved.mediaId, { onDelete: "cascade" }),
    collectionName: text("collection_name").notNull(),
  },
  (table) => [
    uniqueIndex("item_collections_uidx").on(
      table.itemId,
      table.collectionName,
    ),
    index("item_collections_name_idx").on(table.collectionName),
  ],
);

export const liked = sqliteTable(
  "liked",
  {
    mediaId: integer("media_id")
      .primaryKey()
      .references(() => media.id, { onDelete: "cascade" }),
    likedAt: integer("liked_at", { mode: "timestamp" }),
    source: text("source", {
      enum: ["liked_posts", "story_likes"],
    })
      .notNull()
      .default("liked_posts"),
    firstSeenImportId: integer("first_seen_import_id")
      .notNull()
      .references(() => imports.id),
    lastSeenImportId: integer("last_seen_import_id")
      .notNull()
      .references(() => imports.id),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(unixepoch),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(unixepoch),
  },
  (table) => [
    index("liked_liked_at_idx").on(table.likedAt),
    index("liked_source_idx").on(table.source),
  ],
);

export const importSchemas = sqliteTable(
  "import_schemas",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    importId: integer("import_id")
      .notNull()
      .references(() => imports.id, { onDelete: "cascade" }),
    filePath: text("file_path").notNull(),
    byteSize: integer("byte_size").notNull().default(0),
    truncatedRead: integer("truncated_read", { mode: "boolean" })
      .notNull()
      .default(false),
    topLevelType: text("top_level_type").notNull().default("unknown"),
    schemaJson: text("schema_json").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(unixepoch),
  },
  (table) => [
    uniqueIndex("import_schemas_import_path_uidx").on(
      table.importId,
      table.filePath,
    ),
    index("import_schemas_import_id_idx").on(table.importId),
    index("import_schemas_file_path_idx").on(table.filePath),
  ],
);

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(unixepoch),
});

export const embeddingJobs = sqliteTable(
  "embedding_jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    target: text("target").notNull(),
    state: text("state").notNull().default("running"),
    phase: text("phase").notNull().default("queued"),
    processed: integer("processed").notNull().default(0),
    total: integer("total").notNull().default(0),
    currentProvider: text("current_provider"),
    error: text("error"),
    message: text("message"),
    cancelRequested: integer("cancel_requested", { mode: "boolean" })
      .notNull()
      .default(false),
    workerPid: integer("worker_pid"),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp" }),
    startedAt: integer("started_at", { mode: "timestamp" })
      .notNull()
      .default(unixepoch),
    finishedAt: integer("finished_at", { mode: "timestamp" }),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(unixepoch),
  },
  (table) => [
    index("embedding_jobs_state_idx").on(table.state),
    index("embedding_jobs_started_idx").on(table.startedAt),
  ],
);

export const importJobs = sqliteTable(
  "import_jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    filename: text("filename").notNull(),
    contentHash: text("content_hash"),
    spoolPath: text("spool_path").notNull(),
    kind: text("kind").notNull().default("zip"),
    state: text("state").notNull().default("pending"),
    phase: text("phase").notNull().default("queued"),
    processed: integer("processed").notNull().default(0),
    total: integer("total").notNull().default(0),
    message: text("message"),
    error: text("error"),
    details: text("details"),
    result: text("result"),
    importId: integer("import_id").references(() => imports.id),
    cancelRequested: integer("cancel_requested", { mode: "boolean" })
      .notNull()
      .default(false),
    startedAt: integer("started_at", { mode: "timestamp" })
      .notNull()
      .default(unixepoch),
    finishedAt: integer("finished_at", { mode: "timestamp" }),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(unixepoch),
  },
  (table) => [
    index("import_jobs_state_idx").on(table.state),
    index("import_jobs_started_idx").on(table.startedAt),
  ],
);

export const embeddingIndexProfiles = sqliteTable(
  "embedding_index_profiles",
  {
    indexName: text("index_name").primaryKey(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    dimensions: integer("dimensions").notNull(),
    endpoint: text("endpoint"),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(unixepoch),
  },
  (table) => [
    check(
      "embedding_index_profiles_name_check",
      sql`${table.indexName} in ('local', 'ollama', 'openai', 'voyage', 'likes-local', 'likes-ollama', 'likes-openai', 'likes-voyage')`,
    ),
  ],
);

export const importsRelations = relations(imports, ({ many }) => ({
  saved: many(saved),
  liked: many(liked),
  schemas: many(importSchemas),
}));

export const importSchemasRelations = relations(importSchemas, ({ one }) => ({
  import: one(imports, {
    fields: [importSchemas.importId],
    references: [imports.id],
  }),
}));

export const mediaRelations = relations(media, ({ one }) => ({
  saved: one(saved),
  liked: one(liked),
}));

export const savedRelations = relations(saved, ({ one, many }) => ({
  media: one(media, {
    fields: [saved.mediaId],
    references: [media.id],
  }),
  firstSeenImport: one(imports, {
    fields: [saved.firstSeenImportId],
    references: [imports.id],
    relationName: "firstSeen",
  }),
  lastSeenImport: one(imports, {
    fields: [saved.lastSeenImportId],
    references: [imports.id],
    relationName: "lastSeen",
  }),
  collections: many(itemCollections),
}));

export const likedRelations = relations(liked, ({ one }) => ({
  media: one(media, {
    fields: [liked.mediaId],
    references: [media.id],
  }),
  firstSeenImport: one(imports, {
    fields: [liked.firstSeenImportId],
    references: [imports.id],
    relationName: "likedFirstSeen",
  }),
  lastSeenImport: one(imports, {
    fields: [liked.lastSeenImportId],
    references: [imports.id],
    relationName: "likedLastSeen",
  }),
}));

export const itemCollectionsRelations = relations(
  itemCollections,
  ({ one }) => ({
    item: one(saved, {
      fields: [itemCollections.itemId],
      references: [saved.mediaId],
    }),
  }),
);

export type Import = typeof imports.$inferSelect;
export type Media = typeof media.$inferSelect;
export type Saved = typeof saved.$inferSelect;
export type Liked = typeof liked.$inferSelect;
export type ItemCollection = typeof itemCollections.$inferSelect;
export type ImportSchema = typeof importSchemas.$inferSelect;
