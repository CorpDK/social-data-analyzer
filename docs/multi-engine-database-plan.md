# Multi-Engine Database Support (SQLite default + Postgres)

Status: **ME-3 landed — greenfield Drizzle journals** (Aug 2026). Phases 4–6 remain.

Goal: refactor from hard-wired better-sqlite3 to an async port-based storage
layer with two full backends — SQLite (default, embedded) and Postgres
(node-postgres + pgvector + tsvector, user-provided server) — selected by
config, with Drizzle Kit migrations per dialect and an engine-to-engine data
migration tool.

Decision record: PGlite was evaluated and rejected as the embedded Postgres
flavor (alpha status, single-process data-dir ownership incompatible with the
embedding worker child process, 0.x on-disk format churn). The Postgres
backend targets real servers only.

## Phase checklist

- [x] Phase 1: Define async port interfaces (`CatalogStore`, `SearchIndex`, `JobStore`, `SettingsStore`, `MaintenanceOps`) and move existing SQLite code into `src/lib/storage/sqlite/` behind them
- [x] Phase 2: Async-ify all call sites (routes, pages, SSE snapshots, scripts, worker), remove `getSqlite()` defaults and top-level HMR ensure, adapt existing tests; full suite green on SQLite
- [x] Phase 3: Move all plain tables to Drizzle schemas per dialect with Drizzle Kit migrations; shrink hand-rolled DDL to FTS5/vec0 (SQLite) and journaled extension/tsvector/vector SQL (PG); stamp empty SQLite databases at v10 and reject legacy/non-empty unstamped files; rewrite `docs/db-boundary.md`
- [ ] Phase 4: Implement Postgres backend (pg Pool, tsvector search docs, pgvector embeddings, jobs with lease reclaim, maintenance/reset, engine-aware UI), validate distance-metric parity, add docker-compose recipe
- [ ] Phase 5: Port contract tests against both engines (Testcontainers pgvector), parameterize Gate A harness and soak over engine, optional Postgres e2e project
- [ ] Phase 6: Build `scripts/migrate-engine.ts` for bidirectional SQLite/Postgres library migration with identity preservation; document in runbook; fresh start remains default

## Target architecture

```mermaid
flowchart TD
    routes[API_routes_and_pages] --> ports
    worker[scripts/embedding-worker.ts] --> ports
    cli[reindex_soak_migrate_CLIs] --> ports
    subgraph ports [Storage ports - all async]
        catalog[CatalogStore]
        search[SearchIndex]
        jobs[JobStore]
        settings[SettingsStore]
        maint[MaintenanceOps]
    end
    ports --> sqliteImpl["SQLite impl (better-sqlite3 + FTS5 + sqlite-vec)"]
    ports --> pgImpl["Postgres impl (pg + tsvector + pgvector)"]
    sqliteImpl --> sfile[(data/instagram-saves.db)]
    pgImpl --> pgsrv[(Postgres server, user-provided)]
```

Engine selection: `INSTAGRAM_SAVES_DATABASE_URL=postgres://…` selects
Postgres; otherwise SQLite at `INSTAGRAM_SAVES_DB` (current default path). A
`getStorage(): Promise<Storage>` factory replaces `getSqlite()`/`getDb()` as
the app-wide entry point (cached on `globalThis` like today, in
`src/lib/storage/index.ts`). Connection lifecycle lives in
`src/lib/storage/sqlite/connection.ts`; `src/lib/db/index.ts` keeps internal
compatibility re-exports while app call sites use the ports.

## Phase 1 — Define ports and restructure the SQLite code behind them

Create `src/lib/storage/ports.ts` with async interfaces derived from today's
exact call surface:

- **CatalogStore** — everything in `src/lib/queries.ts` and
  `src/lib/schema-catalog.ts`, plus import writes: `applyParsedItems` /
  `applyLikedItems` / `persistImportSchemas`
  (`src/lib/import/write-batches.ts`), `appendImportNotes`,
  `countPersistedImportRows`, `rollbackImportInserts` /
  `discardImportInserts`. Batch transactions stay inside the impl.
- **SearchIndex** — FTS upsert/remove/count (`src/lib/search/sync-fts.ts`),
  vector store ops + profiles (`src/lib/search/sync-vec-store.ts`), row
  loaders (`src/lib/search/sync-rows.ts`), keyword+vector query primitives
  used by `src/lib/search/hybrid.ts`, vec integrity, gap assessment.
  Engine-neutral logic (RRF fusion, chunking, resume policy, rebuild
  orchestration in `sync.ts` / `sync-embed.ts`) stays shared and calls the
  port.
- **JobStore** — `embedding_jobs` + `import_jobs` CRUD
  (`src/lib/search/jobs-records.ts`, `src/lib/search/jobs.ts`,
  `src/lib/import/jobs.ts`) and reclaim (`src/lib/job-queue.ts`).
  Runner/spawn policy (jobs-spawn, worker-policy, memory gates) stays shared.
- **SettingsStore** — `app_settings` KV
  (`src/lib/settings/app-settings.ts`); env-fallback resolution stays shared.
- **MaintenanceOps** — busy state (`src/lib/settings/library-busy.ts`),
  maintenance actions + stats (`src/lib/settings/db-maintenance.ts`), reset
  (`src/lib/settings/reset-library.ts`), integrity check, plus an
  `engineInfo()` capability descriptor (engine name, supported maintenance
  actions, search tech labels for UI copy).

Move current code to `src/lib/storage/sqlite/` as the first implementation,
preserving behavior exactly (WAL pragmas, sqlite-vec load, schema ensure,
orphan reclaim on open, `EMBEDDING_WORKER_CHILD` skip).

## Phase 2 — Async-ify every call site (still SQLite-only, no behavior change)

All port methods are async; the SQLite impl fulfills them trivially. Convert
the known hard spots:

- Remove module-top-level HMR `ensureDatabaseSchema` in `db/index.ts` → lazy
  `getStorage()` with cached init promise.
- Eliminate all `sqlite = getSqlite()` default parameters (sync-fts,
  sync-vec-store, sync-rows, app-settings, vec-integrity) — ports are
  injected/resolved instead.
- SSE stream routes (`src/app/api/import/jobs/stream/route.ts`,
  `src/app/api/search/status/stream/route.ts`): make `getSnapshot` async in
  `createJobSseResponse`.
- Sync server components → async: `src/components/overview-dashboard.tsx`,
  `src/app/import/page.tsx` (other DB pages are already async).
- Replace `sleepSyncMs` (`Atomics.wait`) in the reclaim path with async sleep.
- Update all 20 API routes, remaining pages, and scripts
  (`embedding-worker.ts`, `reindex-search.ts`, `soak-scale.ts`) to `await`
  the ports.
- Adapt tests that mock `getSqlite` or build `:memory:` DBs
  (`db-maintenance.test.ts`, `library-busy.test.ts`, `job-queue.test.ts`,
  `vec-integrity.test.ts`, `hybrid.test.ts`, `readiness.test.ts`,
  `fault-inject.test.ts`, Gate A harness) to construct the SQLite storage
  impl directly.

Exit gate: `pnpm test:all` + e2e green, app behavior-identical on SQLite.

## Phase 3 — Migration system: Drizzle Kit for everything expressible

- Expand Drizzle schemas to cover all plain tables: catalog (already there) +
  `app_settings`, `embedding_jobs`, `import_jobs`,
  `embedding_index_profiles`. Two schema files:
  `src/lib/storage/sqlite/schema.ts` (sqlite-core) and
  `src/lib/storage/postgres/schema.ts` (pg-core).
- Two drizzle-kit configs and migration folders (`drizzle/sqlite/`,
  `drizzle/postgres/`). SQLite migrations run programmatically at storage init
  via Drizzle's migrator; the Postgres journal is ready for the ME-4 connection
  bootstrap.
- Hand-rolled DDL shrinks to a per-engine `ensureSearchSchema`: SQLite keeps
  FTS5 + vec0 create/recreate from `src/lib/db/ddl.ts`; Postgres uses
  custom-SQL migration files for `CREATE EXTENSION vector`, tsvector
  generated columns, and GIN/HNSW indexes (drizzle-kit supports raw SQL
  migrations, so these still live in the journal).
- Greenfield transition: v10 accepts only an empty database (then applies the
  journal) or an already journaled v10 database. Versions 1–9 and unstamped
  non-empty files are rejected with a wipe/reimport instruction.
- Rewrite `docs/db-boundary.md`: new rule set (Drizzle Kit owns plain tables
  per dialect; hand-rolled SQL owns virtual/extension DDL only; ports own all
  access).

## Phase 4 — Postgres backend

`src/lib/storage/postgres/` implementing all five ports over a `pg` Pool:

- **Schema mapping**: identity columns for autoincrement PKs;
  `timestamptz`/epoch handling replacing `unixepoch()`; per-library
  search-doc tables `saved_items_search` / `liked_items_search` (denormalized
  author/shortcode/media_key/media_type/collections-or-source, tsvector
  generated column, GIN index) maintained by the same delete+insert pattern
  as FTS5 today; embeddings as
  `saved_item_embeddings(item_id, provider, embedding vector(1024))`
  (PK `(item_id, provider)`) + likes twin, exact `<=>` KNN with optional HNSW
  partial indexes per provider.
- **Search**: `websearch_to_tsquery` + `ts_rank` replaces `MATCH`/`rank`
  (port of `buildFtsQuery`); KNN via `ORDER BY embedding <=> $1 LIMIT k`.
  Validation item: sqlite-vec `vec0` defaults to L2 distance while pgvector
  `<=>` is cosine — confirm the current metric and normalize
  behavior/thresholds (`VEC_DISTANCE_MAX`/`SLACK`) so RRF ranking stays
  comparable across engines.
- **Jobs**: identical columns and lease semantics (`worker_pid`,
  `lease_expires_at`); the embedding worker child keeps its process design,
  opening its own connection — reclaim's `/proc` cmdline probe is
  engine-agnostic and unchanged.
- **Maintenance/reset**: `VACUUM (ANALYZE)`, `pg_database_size`,
  `pg_stat_user_tables` dead-tuple stats; no WAL checkpoint → capability
  flags drive the UI. Reset via ordered `TRUNCATE … RESTART IDENTITY` +
  search-doc/embedding truncation + spool clear.
- **UI/copy adaptation**: `src/components/db-maintenance.tsx` renders
  engine-provided stats/actions; hardcoded "FTS5"/"sqlite-vec" strings in
  `saves-browser`, `likes-browser`, `overview-dashboard` come from
  `engineInfo()`.
- **Provisioning**: `docker-compose.postgres.yml` using a pgvector image +
  `.env` example; runbook section for backup (`pg_dump`) and ops.

## Phase 5 — Test infrastructure for two engines

- Contract test suite: one spec file per port run against both
  implementations (SQLite `:memory:`; Postgres via Testcontainers with a
  pgvector image), tagged so `pnpm test` stays fast without Docker and
  `pnpm test:pg` runs the full matrix.
- Gate A harness (`scripts/tests/harness.ts`) parameterized over engine;
  Playwright e2e gets an optional Postgres project.
- Soak script gains `--engine=postgres` mode.

## Phase 6 — Engine-to-engine migration tool

`scripts/migrate-engine.ts` (+ runbook docs): reads source storage, writes
target through the ports with identity preservation — catalog rows (explicit
IDs), collections, import history + schemas, `app_settings`,
`embedding_index_profiles`, and embeddings (readable back from vec0 as
float32 blobs → `vector` values, and vice versa); search docs rebuilt from
catalog on the target; job history optionally copied. Refuses to run into a
non-empty target. Fresh start remains the default path — the tool is opt-in;
both engines bootstrap empty databases automatically.

## Key risks

- Distance-metric parity (L2 vs cosine) between sqlite-vec and pgvector —
  must be validated in Phase 4 before hybrid thresholds are trusted.
- The Phase 2 async conversion is the widest change surface (~40 files, 20
  routes); it lands as pure refactor with the full test suite as the gate
  before any Postgres code exists.
- The greenfield SQLite gate must continue rejecting legacy and unstamped
  non-empty files while allowing empty and already journaled v10 databases.
