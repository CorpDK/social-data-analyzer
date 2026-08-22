CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
--> statement-breakpoint
CREATE TABLE "saved_items_search" (
  "item_id" integer PRIMARY KEY REFERENCES "saved_items"("id") ON DELETE CASCADE,
  "author_username" text,
  "shortcode" text,
  "media_key" text NOT NULL,
  "media_type" text NOT NULL,
  "collections" text NOT NULL DEFAULT '',
  "search_vector" tsvector GENERATED ALWAYS AS (
    to_tsvector(
      'simple',
      coalesce("author_username", '') || ' ' ||
      coalesce("shortcode", '') || ' ' ||
      "media_key" || ' ' ||
      "media_type" || ' ' ||
      "collections"
    )
  ) STORED
);
--> statement-breakpoint
CREATE INDEX "saved_items_search_vector_idx"
  ON "saved_items_search" USING gin ("search_vector");
--> statement-breakpoint
CREATE TABLE "liked_items_search" (
  "item_id" integer PRIMARY KEY REFERENCES "liked_items"("id") ON DELETE CASCADE,
  "author_username" text,
  "shortcode" text,
  "media_key" text NOT NULL,
  "media_type" text NOT NULL,
  "source" text NOT NULL,
  "search_vector" tsvector GENERATED ALWAYS AS (
    to_tsvector(
      'simple',
      coalesce("author_username", '') || ' ' ||
      coalesce("shortcode", '') || ' ' ||
      "media_key" || ' ' ||
      "media_type" || ' ' ||
      "source"
    )
  ) STORED
);
--> statement-breakpoint
CREATE INDEX "liked_items_search_vector_idx"
  ON "liked_items_search" USING gin ("search_vector");
--> statement-breakpoint
CREATE TABLE "saved_item_embeddings" (
  "item_id" integer NOT NULL REFERENCES "saved_items"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "embedding" vector(1024) NOT NULL,
  PRIMARY KEY ("item_id", "provider"),
  CONSTRAINT "saved_item_embeddings_provider_check"
    CHECK ("provider" IN ('local', 'ollama', 'openai', 'voyage'))
);
--> statement-breakpoint
CREATE TABLE "liked_item_embeddings" (
  "item_id" integer NOT NULL REFERENCES "liked_items"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "embedding" vector(1024) NOT NULL,
  PRIMARY KEY ("item_id", "provider"),
  CONSTRAINT "liked_item_embeddings_provider_check"
    CHECK ("provider" IN ('local', 'ollama', 'openai', 'voyage'))
);
--> statement-breakpoint
CREATE INDEX "saved_item_embeddings_cosine_idx"
  ON "saved_item_embeddings" USING hnsw ("embedding" vector_cosine_ops);
--> statement-breakpoint
CREATE INDEX "liked_item_embeddings_cosine_idx"
  ON "liked_item_embeddings" USING hnsw ("embedding" vector_cosine_ops);