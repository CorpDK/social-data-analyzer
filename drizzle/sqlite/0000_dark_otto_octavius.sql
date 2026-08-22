CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `embedding_index_profiles` (
	`index_name` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`dimensions` integer NOT NULL,
	`endpoint` text,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT "embedding_index_profiles_name_check" CHECK("embedding_index_profiles"."index_name" in ('local', 'ollama', 'openai', 'voyage', 'likes-local', 'likes-ollama', 'likes-openai', 'likes-voyage'))
);
--> statement-breakpoint
CREATE TABLE `embedding_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`target` text NOT NULL,
	`state` text DEFAULT 'running' NOT NULL,
	`phase` text DEFAULT 'queued' NOT NULL,
	`processed` integer DEFAULT 0 NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`current_provider` text,
	`error` text,
	`message` text,
	`cancel_requested` integer DEFAULT false NOT NULL,
	`worker_pid` integer,
	`lease_expires_at` integer,
	`started_at` integer DEFAULT (unixepoch()) NOT NULL,
	`finished_at` integer,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `embedding_jobs_state_idx` ON `embedding_jobs` (`state`);--> statement-breakpoint
CREATE INDEX `embedding_jobs_started_idx` ON `embedding_jobs` (`started_at`);--> statement-breakpoint
CREATE TABLE `import_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`filename` text NOT NULL,
	`content_hash` text,
	`spool_path` text NOT NULL,
	`kind` text DEFAULT 'zip' NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`phase` text DEFAULT 'queued' NOT NULL,
	`processed` integer DEFAULT 0 NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`message` text,
	`error` text,
	`details` text,
	`result` text,
	`import_id` integer,
	`cancel_requested` integer DEFAULT false NOT NULL,
	`started_at` integer DEFAULT (unixepoch()) NOT NULL,
	`finished_at` integer,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`import_id`) REFERENCES `imports`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `import_jobs_state_idx` ON `import_jobs` (`state`);--> statement-breakpoint
CREATE INDEX `import_jobs_started_idx` ON `import_jobs` (`started_at`);--> statement-breakpoint
CREATE TABLE `import_schemas` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`import_id` integer NOT NULL,
	`file_path` text NOT NULL,
	`byte_size` integer DEFAULT 0 NOT NULL,
	`truncated_read` integer DEFAULT false NOT NULL,
	`top_level_type` text DEFAULT 'unknown' NOT NULL,
	`schema_json` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`import_id`) REFERENCES `imports`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_schemas_import_path_uidx` ON `import_schemas` (`import_id`,`file_path`);--> statement-breakpoint
CREATE INDEX `import_schemas_import_id_idx` ON `import_schemas` (`import_id`);--> statement-breakpoint
CREATE INDEX `import_schemas_file_path_idx` ON `import_schemas` (`file_path`);--> statement-breakpoint
CREATE TABLE `imports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`filename` text NOT NULL,
	`content_hash` text NOT NULL,
	`imported_at` integer DEFAULT (unixepoch()) NOT NULL,
	`items_found` integer DEFAULT 0 NOT NULL,
	`items_added` integer DEFAULT 0 NOT NULL,
	`items_updated` integer DEFAULT 0 NOT NULL,
	`items_skipped` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'completed' NOT NULL,
	`error` text,
	`notes` text
);
--> statement-breakpoint
CREATE INDEX `imports_content_hash_idx` ON `imports` (`content_hash`);--> statement-breakpoint
CREATE TABLE `item_collections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` integer NOT NULL,
	`collection_name` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `saved`(`media_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `item_collections_uidx` ON `item_collections` (`item_id`,`collection_name`);--> statement-breakpoint
CREATE INDEX `item_collections_name_idx` ON `item_collections` (`collection_name`);--> statement-breakpoint
CREATE TABLE `liked` (
	`media_id` integer PRIMARY KEY NOT NULL,
	`liked_at` integer,
	`source` text DEFAULT 'liked_posts' NOT NULL,
	`first_seen_import_id` integer NOT NULL,
	`last_seen_import_id` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`first_seen_import_id`) REFERENCES `imports`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`last_seen_import_id`) REFERENCES `imports`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `liked_liked_at_idx` ON `liked` (`liked_at`);--> statement-breakpoint
CREATE INDEX `liked_source_idx` ON `liked` (`source`);--> statement-breakpoint
CREATE TABLE `media` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`media_key` text NOT NULL,
	`href` text NOT NULL,
	`shortcode` text,
	`media_type` text DEFAULT 'unknown' NOT NULL,
	`author_username` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_media_key_uidx` ON `media` (`media_key`);--> statement-breakpoint
CREATE INDEX `media_author_idx` ON `media` (`author_username`);--> statement-breakpoint
CREATE INDEX `media_type_idx` ON `media` (`media_type`);--> statement-breakpoint
CREATE TABLE `saved` (
	`media_id` integer PRIMARY KEY NOT NULL,
	`saved_at` integer,
	`first_seen_import_id` integer NOT NULL,
	`last_seen_import_id` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`first_seen_import_id`) REFERENCES `imports`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`last_seen_import_id`) REFERENCES `imports`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `saved_saved_at_idx` ON `saved` (`saved_at`);