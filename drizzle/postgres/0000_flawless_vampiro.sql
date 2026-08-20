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
CREATE TABLE "liked_items" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "liked_items_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"media_key" text NOT NULL,
	"href" text NOT NULL,
	"shortcode" text,
	"media_type" text DEFAULT 'unknown' NOT NULL,
	"author_username" text,
	"liked_at" timestamp with time zone,
	"source" text DEFAULT 'liked_posts' NOT NULL,
	"first_seen_import_id" integer NOT NULL,
	"last_seen_import_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_items" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "saved_items_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"media_key" text NOT NULL,
	"href" text NOT NULL,
	"shortcode" text,
	"media_type" text DEFAULT 'unknown' NOT NULL,
	"author_username" text,
	"saved_at" timestamp with time zone,
	"first_seen_import_id" integer NOT NULL,
	"last_seen_import_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_schemas" ADD CONSTRAINT "import_schemas_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_collections" ADD CONSTRAINT "item_collections_item_id_saved_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."saved_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "liked_items" ADD CONSTRAINT "liked_items_first_seen_import_id_imports_id_fk" FOREIGN KEY ("first_seen_import_id") REFERENCES "public"."imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "liked_items" ADD CONSTRAINT "liked_items_last_seen_import_id_imports_id_fk" FOREIGN KEY ("last_seen_import_id") REFERENCES "public"."imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_items" ADD CONSTRAINT "saved_items_first_seen_import_id_imports_id_fk" FOREIGN KEY ("first_seen_import_id") REFERENCES "public"."imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_items" ADD CONSTRAINT "saved_items_last_seen_import_id_imports_id_fk" FOREIGN KEY ("last_seen_import_id") REFERENCES "public"."imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
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
CREATE UNIQUE INDEX "liked_items_media_key_uidx" ON "liked_items" USING btree ("media_key");--> statement-breakpoint
CREATE INDEX "liked_items_author_idx" ON "liked_items" USING btree ("author_username");--> statement-breakpoint
CREATE INDEX "liked_items_type_idx" ON "liked_items" USING btree ("media_type");--> statement-breakpoint
CREATE INDEX "liked_items_liked_at_idx" ON "liked_items" USING btree ("liked_at");--> statement-breakpoint
CREATE INDEX "liked_items_source_idx" ON "liked_items" USING btree ("source");--> statement-breakpoint
CREATE UNIQUE INDEX "saved_items_media_key_uidx" ON "saved_items" USING btree ("media_key");--> statement-breakpoint
CREATE INDEX "saved_items_author_idx" ON "saved_items" USING btree ("author_username");--> statement-breakpoint
CREATE INDEX "saved_items_type_idx" ON "saved_items" USING btree ("media_type");--> statement-breakpoint
CREATE INDEX "saved_items_saved_at_idx" ON "saved_items" USING btree ("saved_at");