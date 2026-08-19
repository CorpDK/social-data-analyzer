# SQLite ownership boundary

This app uses one SQLite file (`data/instagram-saves.db` by default) with two
access styles on purpose. Do not unify them with Drizzle Kit migrations or a
full ORM rewrite of FTS/vec/jobs.

## Ownership map

| Concern | Owner | Access |
|---------|--------|--------|
| Relational catalog (imports, saved_items, liked_items, collections, import_schemas) | Drizzle schema + `getDb()` | `src/lib/db/schema.ts`, `queries.ts`, import write paths |
| App settings key/value | Raw SQL | `app_settings` via `settings/app-settings.ts` (also created in DDL) |
| Import / embedding job rows | Raw SQL | `import_jobs`, `embedding_jobs` in `import/jobs.ts`, `search/jobs.ts` |
| FTS5 indexes | Raw SQL | `saved_items_fts`, `liked_items_fts` — sync + hybrid search |
| sqlite-vec tables + embedding profiles | Raw SQL | `*_vec_*`, `embedding_index_profiles` — `search/sync.ts`, status |
| Schema bootstrap / version | Raw SQL DDL | `ensureDatabaseSchema` + `SCHEMA_VERSION` in `src/lib/db/ddl.ts` |

## Rules of thumb

- **Drizzle** = typed CRUD for the relational catalog the UI browses and import
  persists into.
- **Raw `better-sqlite3` (`getSqlite()`)** = FTS, vectors, job queues,
  `app_settings`, and all idempotent DDL / migrations.
- Bump `SCHEMA_VERSION` whenever the idempotent DDL in `db/ddl.ts` gains or
  changes a table/index. Development re-applies DDL on module re-evaluation.
- Do **not** introduce Drizzle Kit migrations while `SCHEMA_VERSION` churn stays
  rare (see quality roadmap deferred list).
- Job tables and virtual tables are intentionally absent from
  `schema.ts` — they are not Drizzle models.

## Related

- Wire/job contracts: `docs/contracts.md`
- Connection entry: `src/lib/storage` (`getStorage`) + `src/lib/storage/sqlite/connection.ts`
  (`getSqlite` / `getDb`; also re-exported from `src/lib/db` until ME-2)
- DDL + `SCHEMA_VERSION`: `src/lib/db/ddl.ts`
- Drizzle catalog only: `src/lib/db/schema.ts`
- Ports: `src/lib/storage/ports.ts` (ME-1); call-site await conversion is ME-2
