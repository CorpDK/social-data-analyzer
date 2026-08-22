/**
 * Postgres plain-table schema for Drizzle Kit.
 *
 * The ME-4 backend will consume these tables. Search extensions, generated
 * tsvector documents, and vector indexes belong to custom SQL migrations.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const id = (name = "id") =>
  integer(name).primaryKey().generatedAlwaysAsIdentity();

export const imports = pgTable(
  "imports",
  {
    id: id(),
    filename: text("filename").notNull(),
    contentHash: text("content_hash").notNull(),
    importedAt: timestamp("imported_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    itemsFound: integer("items_found").notNull().default(0),
    itemsAdded: integer("items_added").notNull().default(0),
    itemsUpdated: integer("items_updated").notNull().default(0),
    itemsSkipped: integer("items_skipped").notNull().default(0),
    status: text("status").notNull().default("completed"),
    error: text("error"),
    notes: text("notes"),
  },
  (table) => [index("imports_content_hash_idx").on(table.contentHash)],
);

export const media = pgTable(
  "media",
  {
    id: id(),
    mediaKey: text("media_key").notNull(),
    href: text("href").notNull(),
    shortcode: text("shortcode"),
    mediaType: text("media_type").notNull().default("unknown"),
    authorUsername: text("author_username"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("media_media_key_uidx").on(table.mediaKey),
    index("media_author_idx").on(table.authorUsername),
    index("media_type_idx").on(table.mediaType),
  ],
);

export const saved = pgTable(
  "saved",
  {
    mediaId: integer("media_id")
      .primaryKey()
      .references(() => media.id, { onDelete: "cascade" }),
    savedAt: timestamp("saved_at", { withTimezone: true }),
    firstSeenImportId: integer("first_seen_import_id")
      .notNull()
      .references(() => imports.id),
    lastSeenImportId: integer("last_seen_import_id")
      .notNull()
      .references(() => imports.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("saved_saved_at_idx").on(table.savedAt)],
);

export const itemCollections = pgTable(
  "item_collections",
  {
    id: id(),
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

export const liked = pgTable(
  "liked",
  {
    mediaId: integer("media_id")
      .primaryKey()
      .references(() => media.id, { onDelete: "cascade" }),
    likedAt: timestamp("liked_at", { withTimezone: true }),
    source: text("source").notNull().default("liked_posts"),
    firstSeenImportId: integer("first_seen_import_id")
      .notNull()
      .references(() => imports.id),
    lastSeenImportId: integer("last_seen_import_id")
      .notNull()
      .references(() => imports.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("liked_liked_at_idx").on(table.likedAt),
    index("liked_source_idx").on(table.source),
  ],
);

export const importSchemas = pgTable(
  "import_schemas",
  {
    id: id(),
    importId: integer("import_id")
      .notNull()
      .references(() => imports.id, { onDelete: "cascade" }),
    filePath: text("file_path").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull().default(0),
    truncatedRead: boolean("truncated_read").notNull().default(false),
    topLevelType: text("top_level_type").notNull().default("unknown"),
    schemaJson: text("schema_json").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const embeddingJobs = pgTable(
  "embedding_jobs",
  {
    id: id(),
    target: text("target").notNull(),
    state: text("state").notNull().default("running"),
    phase: text("phase").notNull().default("queued"),
    processed: integer("processed").notNull().default(0),
    total: integer("total").notNull().default(0),
    currentProvider: text("current_provider"),
    error: text("error"),
    message: text("message"),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    workerPid: integer("worker_pid"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("embedding_jobs_state_idx").on(table.state),
    index("embedding_jobs_started_idx").on(table.startedAt.desc()),
  ],
);

export const importJobs = pgTable(
  "import_jobs",
  {
    id: id(),
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
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("import_jobs_state_idx").on(table.state),
    index("import_jobs_started_idx").on(table.startedAt.desc()),
  ],
);

export const embeddingIndexProfiles = pgTable(
  "embedding_index_profiles",
  {
    indexName: text("index_name").primaryKey(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    dimensions: integer("dimensions").notNull(),
    endpoint: text("endpoint"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "embedding_index_profiles_name_check",
      sql`${table.indexName} in ('local', 'ollama', 'openai', 'voyage', 'likes-local', 'likes-ollama', 'likes-openai', 'likes-voyage')`,
    ),
  ],
);
