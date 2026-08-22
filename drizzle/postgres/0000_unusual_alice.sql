CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "embedding_index_profiles" (
	"index_name" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"dimensions" integer NOT NULL,
	"endpoint" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "embedding_index_profiles_name_check" CHECK ("embedding_index_profiles"."index_name" in ('local', 'ollama', 'openai', 'voyage', 'likes-local', 'likes-ollama', 'likes-openai', 'likes-voyage'))
);
--> statement-breakpoint
CREATE TABLE "embedding_jobs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "embedding_jobs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"target" text NOT NULL,
	"state" text DEFAULT 'running' NOT NULL,
	"phase" text DEFAULT 'queued' NOT NULL,
	"processed" integer DEFAULT 0 NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"current_provider" text,
	"error" text,
	"message" text,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"worker_pid" integer,
	"lease_expires_at" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_jobs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "import_jobs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"filename" text NOT NULL,
	"content_hash" text,
	"spool_path" text NOT NULL,
	"kind" text DEFAULT 'zip' NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"phase" text DEFAULT 'queued' NOT NULL,
	"processed" integer DEFAULT 0 NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"message" text,
	"error" text,
	"details" text,
	"result" text,
	"import_id" integer,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_schemas" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "import_schemas_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"import_id" integer NOT NULL,
	"file_path" text NOT NULL,
	"byte_size" bigint DEFAULT 0 NOT NULL,
	"truncated_read" boolean DEFAULT false NOT NULL,
	"top_level_type" text DEFAULT 'unknown' NOT NULL,
	"schema_json" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "imports" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "imports_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"filename" text NOT NULL,
	"content_hash" text NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"items_found" integer DEFAULT 0 NOT NULL,
	"items_added" integer DEFAULT 0 NOT NULL,
	"items_updated" integer DEFAULT 0 NOT NULL,
	"items_skipped" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"error" text,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "item_collections" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "item_collections_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"item_id" integer NOT NULL,
	"collection_name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "liked" (
	"media_id" integer PRIMARY KEY NOT NULL,
	"liked_at" timestamp with time zone,
	"source" text DEFAULT 'liked_posts' NOT NULL,
	"first_seen_import_id" integer NOT NULL,
	"last_seen_import_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "media_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"media_key" text NOT NULL,
	"href" text NOT NULL,
	"shortcode" text,
	"media_type" text DEFAULT 'unknown' NOT NULL,
	"author_username" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved" (
	"media_id" integer PRIMARY KEY NOT NULL,
	"saved_at" timestamp with time zone,
	"first_seen_import_id" integer NOT NULL,
	"last_seen_import_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_schemas" ADD CONSTRAINT "import_schemas_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_collections" ADD CONSTRAINT "item_collections_item_id_saved_media_id_fk" FOREIGN KEY ("item_id") REFERENCES "saved"("media_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "liked" ADD CONSTRAINT "liked_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "liked" ADD CONSTRAINT "liked_first_seen_import_id_imports_id_fk" FOREIGN KEY ("first_seen_import_id") REFERENCES "imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "liked" ADD CONSTRAINT "liked_last_seen_import_id_imports_id_fk" FOREIGN KEY ("last_seen_import_id") REFERENCES "imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved" ADD CONSTRAINT "saved_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved" ADD CONSTRAINT "saved_first_seen_import_id_imports_id_fk" FOREIGN KEY ("first_seen_import_id") REFERENCES "imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved" ADD CONSTRAINT "saved_last_seen_import_id_imports_id_fk" FOREIGN KEY ("last_seen_import_id") REFERENCES "imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "embedding_jobs_state_idx" ON "embedding_jobs" USING btree ("state");--> statement-breakpoint
CREATE INDEX "embedding_jobs_started_idx" ON "embedding_jobs" USING btree ("started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "import_jobs_state_idx" ON "import_jobs" USING btree ("state");--> statement-breakpoint
CREATE INDEX "import_jobs_started_idx" ON "import_jobs" USING btree ("started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "import_schemas_import_path_uidx" ON "import_schemas" USING btree ("import_id","file_path");--> statement-breakpoint
CREATE INDEX "import_schemas_import_id_idx" ON "import_schemas" USING btree ("import_id");--> statement-breakpoint
CREATE INDEX "import_schemas_file_path_idx" ON "import_schemas" USING btree ("file_path");--> statement-breakpoint
CREATE INDEX "imports_content_hash_idx" ON "imports" USING btree ("content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "item_collections_uidx" ON "item_collections" USING btree ("item_id","collection_name");--> statement-breakpoint
CREATE INDEX "item_collections_name_idx" ON "item_collections" USING btree ("collection_name");--> statement-breakpoint
CREATE INDEX "liked_liked_at_idx" ON "liked" USING btree ("liked_at");--> statement-breakpoint
CREATE INDEX "liked_source_idx" ON "liked" USING btree ("source");--> statement-breakpoint
CREATE UNIQUE INDEX "media_media_key_uidx" ON "media" USING btree ("media_key");--> statement-breakpoint
CREATE INDEX "media_author_idx" ON "media" USING btree ("author_username");--> statement-breakpoint
CREATE INDEX "media_type_idx" ON "media" USING btree ("media_type");--> statement-breakpoint
CREATE INDEX "saved_saved_at_idx" ON "saved" USING btree ("saved_at");