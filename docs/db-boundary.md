# Database ownership boundary

The storage layer has one migration rule across engines: Drizzle Kit owns
ordinary tables; engine-specific SQL owns search features that cannot be
expressed by the portable schema.

## Ownership map

| Concern | Owner | Location |
|---------|-------|----------|
| SQLite plain tables and indexes | Drizzle Kit | `src/lib/storage/sqlite/schema.ts`, `drizzle/sqlite/` |
| Postgres plain tables and indexes | Drizzle Kit | `src/lib/storage/postgres/schema.ts`, `drizzle/postgres/` |
| SQLite FTS5 and sqlite-vec virtual tables | SQLite bootstrap SQL | `src/lib/db/ddl.ts` |
| Postgres vector/tsvector search objects | Custom journaled SQL | `drizzle/postgres/0001_search.sql` |
| Reads, writes, transactions, and maintenance | Async storage ports | `src/lib/storage/ports.ts`, engine adapters |
| SQLite connection and migration startup | SQLite storage | `src/lib/storage/sqlite/connection.ts` |

Plain tables include the catalog plus `app_settings`, `embedding_jobs`,
`import_jobs`, and `embedding_index_profiles`. Do not recreate those tables
with ad hoc `CREATE TABLE IF NOT EXISTS` statements.

## Migration workflow

1. Change the relevant dialect schema.
2. Run `pnpm db:generate` (or one of `db:generate:sqlite` /
   `db:generate:postgres`).
3. Review the generated SQL and journal metadata.
4. Put unsupported engine features in a Drizzle custom SQL migration so they
   remain ordered with the plain-table migrations.
5. Run unit tests and TypeScript checks.

SQLite migrations run automatically when storage opens. The v10 bootstrap is
greenfield-only: it accepts an empty database or an already journaled v10
database. Versions 1–9 and unstamped non-empty files fail with an instruction
to delete the configured database and perform a fresh import. There is no
baseline stamp, dual-read path, or in-place legacy upgrade.

`SCHEMA_VERSION` is a clean-break compatibility marker, not the migration
journal. Bump it only when intentionally starting a new incompatible
greenfield generation; normal forward schema changes use Drizzle migrations.

## Rules of thumb

- App code enters through `await getStorage()` and the async ports.
- Engine adapters may use their native driver internally; callers must not.
- Never hand-edit generated snapshot JSON.
- Never put SQLite virtual tables in the Drizzle schema.
- Never create unjournaled Postgres extensions, generated search columns, or
  vector indexes at runtime.

## Related

- Multi-engine plan: `docs/multi-engine-database-plan.md`
- Wire/job contracts: `docs/contracts.md`
- SQLite bootstrap: `src/lib/db/ddl.ts`
- SQLite migration config: `drizzle.sqlite.config.ts`
- Postgres migration config: `drizzle.postgres.config.ts`
