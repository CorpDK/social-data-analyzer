import { relations, sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const imports = sqliteTable(
  "imports",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    filename: text("filename").notNull(),
    contentHash: text("content_hash").notNull(),
    importedAt: integer("imported_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
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

export const savedItems = sqliteTable(
  "saved_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    mediaKey: text("media_key").notNull(),
    href: text("href").notNull(),
    shortcode: text("shortcode"),
    mediaType: text("media_type", {
      enum: ["post", "reel", "igtv", "unknown"],
    })
      .notNull()
      .default("unknown"),
    authorUsername: text("author_username"),
    savedAt: integer("saved_at", { mode: "timestamp" }),
    firstSeenImportId: integer("first_seen_import_id")
      .notNull()
      .references(() => imports.id),
    lastSeenImportId: integer("last_seen_import_id")
      .notNull()
      .references(() => imports.id),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex("saved_items_media_key_uidx").on(table.mediaKey),
    index("saved_items_author_idx").on(table.authorUsername),
    index("saved_items_type_idx").on(table.mediaType),
    index("saved_items_saved_at_idx").on(table.savedAt),
  ],
);

export const itemCollections = sqliteTable(
  "item_collections",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    itemId: integer("item_id")
      .notNull()
      .references(() => savedItems.id, { onDelete: "cascade" }),
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

export const importsRelations = relations(imports, ({ many }) => ({
  items: many(savedItems),
}));

export const savedItemsRelations = relations(savedItems, ({ one, many }) => ({
  firstSeenImport: one(imports, {
    fields: [savedItems.firstSeenImportId],
    references: [imports.id],
    relationName: "firstSeen",
  }),
  lastSeenImport: one(imports, {
    fields: [savedItems.lastSeenImportId],
    references: [imports.id],
    relationName: "lastSeen",
  }),
  collections: many(itemCollections),
}));

export const itemCollectionsRelations = relations(
  itemCollections,
  ({ one }) => ({
    item: one(savedItems, {
      fields: [itemCollections.itemId],
      references: [savedItems.id],
    }),
  }),
);

export type Import = typeof imports.$inferSelect;
export type SavedItem = typeof savedItems.$inferSelect;
export type ItemCollection = typeof itemCollections.$inferSelect;
