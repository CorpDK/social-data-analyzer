CREATE TABLE "saved_items_search" (
  "item_id" integer PRIMARY KEY REFERENCES "saved"("media_id") ON DELETE CASCADE,
  "author_username" text,
  "shortcode" text,
  "media_key" text NOT NULL,
  "media_type" text NOT NULL,
  "collections" text NOT NULL DEFAULT '',
  "search_vector" tsvector GENERATED ALWAYS AS (
    to_tsvector('simple',
      coalesce("author_username", '') || ' ' ||
      coalesce("shortcode", '') || ' ' ||
      "media_key" || ' ' || "media_type" || ' ' || "collections")
  ) STORED
);
--> statement-breakpoint
CREATE INDEX "saved_items_search_vector_idx"
  ON "saved_items_search" USING gin ("search_vector");
--> statement-breakpoint
CREATE TABLE "liked_items_search" (
  "item_id" integer PRIMARY KEY REFERENCES "liked"("media_id") ON DELETE CASCADE,
  "author_username" text,
  "shortcode" text,
  "media_key" text NOT NULL,
  "media_type" text NOT NULL,
  "source" text NOT NULL,
  "search_vector" tsvector GENERATED ALWAYS AS (
    to_tsvector('simple',
      coalesce("author_username", '') || ' ' ||
      coalesce("shortcode", '') || ' ' ||
      "media_key" || ' ' || "media_type" || ' ' || "source")
  ) STORED
);
--> statement-breakpoint
CREATE INDEX "liked_items_search_vector_idx"
  ON "liked_items_search" USING gin ("search_vector");
--> statement-breakpoint
CREATE TABLE "media_embeddings" (
  "media_id" integer NOT NULL REFERENCES "media"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "embedding" public.vector(1024) NOT NULL,
  PRIMARY KEY ("media_id", "provider"),
  CONSTRAINT "media_embeddings_provider_check"
    CHECK ("provider" IN ('local', 'ollama', 'openai', 'voyage'))
);
--> statement-breakpoint
CREATE INDEX "media_embeddings_cosine_idx"
  ON "media_embeddings" USING hnsw ("embedding" public.vector_cosine_ops);
