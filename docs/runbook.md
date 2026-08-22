# Operator runbook

Short ops guide for this **single-user, local-first** app. Prefer this over
guessing env knobs mid-incident.

## Threat model (local-only)

- The app is meant to run on **loopback (127.0.0.1)** for one operator. There is
  no multi-user auth and no internet-facing hardening.
- `pnpm dev` / `pnpm start` bind **127.0.0.1** so LAN peers cannot connect.
  Open [http://127.0.0.1:3000](http://127.0.0.1:3000) (not a LAN hostname).
- Mutating API routes (`POST` / `PUT` / `PATCH` / `DELETE`) reject:
  - non-loopback `Host`
  - cross-site `Origin`
  - any `X-Forwarded-*` (not trusted; treated as spoof attempts)
- Optional **local token**: set `INSTAGRAM_SAVES_LOCAL_TOKEN` to require
  `Authorization: Bearer …` or `X-Instagram-Saves-Token` on mutations. Same-machine
  hostile pages can still hit loopback without a token; use the token when that
  matters. For the built-in UI, also set
  `NEXT_PUBLIC_INSTAGRAM_SAVES_LOCAL_TOKEN` to the **same** value.
- Soft C-H1 (LAN exposure) shrinks when scripts stay on loopback + Host/Origin
  guard; token mode further covers same-machine CSRF-ish abuse.
- OpenAI / Ollama **base URLs** in Settings are fetched by the **local Node
  process**. That is intentional for LAN Ollama and OpenAI-compatible proxies.
- We do **not** enforce a hard allowlist on those provider URLs (would break
  legitimate LAN Ollama). Settings shows a soft hint when a URL is neither
  loopback nor the official OpenAI API host. See
  `src/lib/settings/base-url-trust.ts` and `docs/contracts.md`.

## Greenfield database bootstrap (SCHEMA 11)

SQLite `SCHEMA_VERSION 11` is the canonical-media generation. Migrations under
`drizzle/sqlite/` run automatically when the app opens an empty database.
Earlier schema versions and unstamped non-empty databases are intentionally
rejected; there is no v10 backfill. Stop the app, delete the configured SQLite
file (default `data/instagram-saves.db`, including its `-wal` / `-shm`
companions), restart, and perform a fresh import.

In v11, `media.id` is the stable catalog/search id. `saved` and `liked` are
membership rows keyed by that id; collections remain saved-only and `source`
remains liked-only. Search FTS rows and SQLite vec0 rows also use `media.id`.

Schema authors generate reviewed migration files with:

```bash
pnpm db:generate
```

Use `pnpm db:generate:sqlite` or `pnpm db:generate:postgres` when changing only
one dialect. Do not run generated SQL manually against the SQLite app database.

## Optional Postgres backend (ME-4)

SQLite remains the default. To start the local pgvector recipe:

```bash
docker compose -f docker-compose.postgres.yml up -d --wait
export INSTAGRAM_SAVES_DATABASE_URL='postgres://instagram_saves:instagram_saves_dev@127.0.0.1:5432/instagram_saves'
export INSTAGRAM_SAVES_PG_SCHEMA='instagram_saves'
export INSTAGRAM_SAVES_PG_TENANCY='database'
pnpm dev
```

Use `INSTAGRAM_SAVES_POSTGRES_PORT=55432` (both for Compose and in the URL) when
port 5432 is occupied. Storage startup applies `drizzle/postgres/`
automatically, including generated `tsvector` documents and indexes. The
database-level `vector` extension must already be installed; the app does not
create it at runtime. Unset `INSTAGRAM_SAVES_DATABASE_URL` to return to SQLite.

Postgres app tables, search indexes, `engine_migration`, and the Drizzle journal
live in `INSTAGRAM_SAVES_PG_SCHEMA` (default `instagram_saves`), including on a
dedicated database. Every pooled connection uses that schema first in
`search_path`; `public` is used only to resolve the database-level vector
extension. There is no automatic move from an older `public` install. For a
greenfield shared cluster, have an administrator create a schema and grant the
app role `USAGE, CREATE`, then set:

```bash
export INSTAGRAM_SAVES_PG_SCHEMA='my_instagram_saves'
export INSTAGRAM_SAVES_PG_TENANCY='schema'
```

The app may create a missing schema only when its role has database-level
`CREATE`; schema-only roles should receive an administrator-created schema.
The app never creates or drops databases and never drops a shared schema.

Advanced storage can check a dedicated database before a copy. The preflight
connects with `INSTAGRAM_SAVES_POSTGRES_CONNECT_TIMEOUT_MS` (default 5000 ms),
reports the server version and role, checks whether `vector` is installed or
available to that role, and checks for an unfinished `engine_migration` copy.
Connection URLs returned to the browser are password-redacted. If the role
cannot enable vector, an administrator should connect to that database and run:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

Before retrying an update or engine copy, have whoever operates PostgreSQL take
a backup. For a shared cluster, dump only the configured app schema so other
applications are left alone. The app never stores backup credentials or runs
database provisioning commands.

The Postgres adapter implements all five storage ports, including import and
embedding queue runner operations.

Back up a Postgres library with:

```bash
pg_dump "$INSTAGRAM_SAVES_DATABASE_URL" --format=custom --file=instagram-saves.dump
```

For schema tenancy, add
`--schema="$INSTAGRAM_SAVES_PG_SCHEMA"` to that command.

Restore into a fresh database with `pg_restore --clean --if-exists`. CI
(`contracts-pg`) runs storage contracts against `pgvector/pgvector:pg17`. Local
smoke still uses this Compose recipe if you want to start the app or construct
`createPostgresStorage` yourself.

## Dual-engine storage contracts (ME-5)

The shared contract suite always runs against an in-memory SQLite database.
When `INSTAGRAM_SAVES_DATABASE_URL` is set and reachable, the same catalog,
jobs, search/FTS/vector, settings, and maintenance assertions also run against
Postgres. Locally, without Postgres it prints a clear skip and remains green.
GitHub Actions always sets the URL against a healthy pgvector service, so
`pnpm test:pg` must execute the Postgres cases (CI fails if the URL is set
but the database is unreachable):

```bash
pnpm test:contracts
```

To run the full matrix locally with the existing pgvector recipe:

```bash
docker compose -f docker-compose.postgres.yml up -d --wait
export INSTAGRAM_SAVES_DATABASE_URL='postgres://instagram_saves:instagram_saves_dev@127.0.0.1:5432/instagram_saves'
pnpm test:pg
```

The Postgres contract suite truncates application tables before and after each
case. Use only the disposable Compose database or another dedicated test
database, never an operator library. The suite does not start Docker itself.

The Gate A parser/import harness remains part of `pnpm test:all`; its
storage-engine-neutral behavior is covered at the port boundary by the shared
contracts. The synthetic soak accepts an explicit engine:

```bash
pnpm soak:scale
INSTAGRAM_SAVES_DATABASE_URL='postgres://…/instagram_saves_test' \
  pnpm soak:scale -- --engine=postgres
```

Use a fresh, disposable Postgres database for the soak because it writes the
synthetic library. Optional browser smoke can target Postgres by exporting the
same URL before `pnpm test:e2e`; Playwright's isolated SQLite path is ignored
when the Postgres URL is configured.

## Switching database engines (ME-6)

The default path is **Settings → Storage engine → Migrate library**:

1. Keep a backup of the current library.
2. Enter an unused SQLite file path or a PostgreSQL URL plus an empty app schema.
3. Choose **Migrate library**. The app copies catalog rows, settings, embedding
   profiles/vectors, rebuilds search documents, verifies integrity, and activates
   the target only after the copy succeeds.
4. Follow live phase, row, and percentage updates in Settings. Import and
   reindex starts are blocked for the duration; migration itself refuses while
   either queue already has pending/running work.

**Switch empty / start fresh** is the optional secondary action. It requires the
typed confirmation `SWITCH EMPTY` and an unused empty target; the existing source
library is left untouched so an export can be imported later. The app does not
dual-read old databases or treat Instagram zip re-import as the default switch.

The selected engine is persisted in `data/storage-engine.json` (mode `0600`) after
successful activation. Until Settings writes this file, environment selection
continues to work as before. For the offline identity-preserving copy tool, stop
every app and worker that can write either endpoint, back up the source, and use
an empty target:

```bash
# SQLite -> Postgres
pnpm migrate:engine -- \
  --from=sqlite \
  --to=postgres \
  --sqlite=/absolute/path/to/instagram-saves.db \
  --postgres-url='postgres://user:password@127.0.0.1:5432/shared' \
  --postgres-schema='instagram_saves'

# Postgres -> SQLite
pnpm migrate:engine -- \
  --from=postgres \
  --to=sqlite \
  --sqlite=/absolute/path/to/new-instagram-saves.db \
  --postgres-url='postgres://user:password@127.0.0.1:5432/shared' \
  --postgres-schema='instagram_saves'
```

The SQLite path and Postgres URL are always required (the URL may instead come
from `INSTAGRAM_SAVES_DATABASE_URL`).
The command refuses a non-empty target, preserves catalog/import identities,
copies canonical `media.id` values and saved/liked memberships, collections,
import schemas, settings, embedding profiles and vectors, rebuilds FTS on the
target, and runs an integrity check. Postgres stores one
`media_embeddings(media_id, provider)` row; SQLite projects the same vector
bytes into each applicable library vec0 table. Finished job history is
operational metadata and is omitted by default; add `--include-jobs` only when
you intentionally want it copied. Spool files referenced by imported job
history are not moved.

SQLite destinations are copied into a sibling `*.engine-migrate` file and
renamed over the target only after integrity checks pass. An interrupted run
leaves the destination unchanged (missing or still empty); leftover staging
files are deleted on the next attempt. Postgres destinations record an
`engine_migration` row as `in_progress` before copying. The app will not open
that database until the copy is marked complete, and Settings surfaces this
blocked state. Retry **Migrate** with the same target, or re-run the same
`pnpm migrate:engine` command after a kill — either path wipes the in-progress
app schema and starts over. Settings offers **Retry copy** (truncate only the
app's qualified table list) or **Choose another target**. Other schemas and
their tables are never touched.

After a successful copy, configure the app for the target engine and compare
the library counts before deleting either source or backup. If the target is
a finished non-empty library, create a fresh target or use the wipe/reimport
path; the tool will not merge libraries.

Postgres uses pgvector cosine distance. Embeddings are L2-normalized before
storage, so ordering is equivalent to SQLite's L2 metric and thresholds convert
with `cosine_distance = l2_distance² / 2`; the default SQLite cutoff `1.22`
therefore corresponds to cosine distance `0.7442`.

## Shortcode / media_key identity

Instagram shortcodes are **case-sensitive**. `mediaKeyFromHref` preserves shortcode
case from the href (usernames/hosts are still normalized where appropriate).

Liked comments no longer collapse to `comment:<post>:<author>` alone: prefer
`fbid` / comment id from the URL, else `post + author + timestamp + content`.

## Collection filter

`listSaves` collection membership uses an `EXISTS` subquery (not a huge bound
`IN (...)` list) so large collections do not hit SQLite variable limits.

## Pagination

`GET /api/saves` and `GET /api/likes` reject malformed `page` / `pageSize` with
**400** (`src/lib/query-params.ts`).

## Reset library vs active jobs (Phase 3)

**Reset library** (Settings → Danger zone) refuses with **HTTP 409** while any
`import_jobs` or `embedding_jobs` row is `pending` or `running`. Cancel or wait
for those jobs first — never wipe the DB under active writers.

## WAL checkpoint / VACUUM (Settings)

Long-lived local DBs can grow a WAL file or accumulate freelist pages. On
**Settings → Database maintenance**:

| Action | API | Effect |
|--------|-----|--------|
| WAL checkpoint | `POST /api/settings/db-maintenance` `{ "action": "checkpoint" }` | `PRAGMA wal_checkpoint(TRUNCATE)` — flush WAL into the main `.db` |
| VACUUM | same route `{ "action": "vacuum" }` | Rebuild the DB file; may take noticeable time on large libraries |

Both refuse with **HTTP 409** (`LIBRARY_BUSY`) while import/reindex jobs are
`pending`/`running`. Prefer checkpoint for routine flush; use VACUUM after big
deletes (or when disk use looks inflated). CLI equivalent (app stopped):

```bash
sqlite3 data/instagram-saves.db 'PRAGMA wal_checkpoint(TRUNCATE);'
sqlite3 data/instagram-saves.db 'VACUUM;'
```

## Partial import recovery

Import writes commit in batches. On fail/cancel the pipeline **rolls back
inserts** (`first_seen_import_id`) so aborted runs do not leave durable new
catalog rows. Residual last_seen-only updates may remain until re-import.

Failed jobs report rollback + residual counts. On the import detail page, use
**Remove rows from this import** (`DELETE /api/imports/:id/rows`) to discard
any remaining inserts, or re-import / idle Reset library.

## Import

1. Open **Import**, upload a Meta JSON zip (max **512 MB**) or standalone
   `.json` (max **512 MB** — Node string-size bound).
2. Job spools under `data/imports/`, row in `import_jobs`, returns 202.
3. Progress: SSE `GET /api/import/jobs/stream` (phases
   `extracting` → … → `writing` → `indexing`).
4. Cancel: `POST /api/import/jobs/cancel` (cooperative).
5. Logs: look for `[import] job=… phase=… processed/total`.

### Upload size honesty

`POST /api/import` **streams** multipart to the spool (boundary parser; no
`request.formData()` full-body buffer). Caps remain **512 MB** for zip (proxy /
host alignment) and **512 MB** for standalone JSON (UTF-8 string parse limit).
Prefer a `.zip` for large exports — JSON entries inside a zip are streamed from
the spool.

`next.config.ts` `experimental.proxyClientMaxBodySize` /
`serverActions.bodySizeLimit` stay aligned via `IMPORT_MAX_FILE_SIZE_LIMIT`
(`512mb`).

## Reindex

1. **Indexes** UI, or `pnpm run reindex` (rebuilds FTS + every enabled provider).
2. Jobs live in `embedding_jobs`; one runs at a time (others stay `pending`).
3. Cancel stops the **active** job only.
4. Logs: `[search] job=…` in the Next process; `[embedding-worker] job=…` in
   the child when workers are enabled.

Embedding input is media-only (author, shortcode, media key, media type, and a
future caption). Collections and like source remain in their library-specific
FTS documents and never alter vectors. When one media id belongs to both
libraries, the first enabled library generates the provider vector and the
second reuses it. PostgreSQL reuses the canonical row directly; SQLite copies
the bytes between vec0 projections, so Voyage/OpenAI/Ollama are not called
twice for overlap.

### Search readiness (no sync backfill on browse)

`getStats` / browse / list GETs are **read-only** — they do **not** call
`ensureSearchIndexBackfill`. `GET /api/search/status` (and SSE) is also
**read-only** for gap healing: it reports `gaps` but does not enqueue jobs.
Use **Heal gaps** on Indexes (`POST /api/search/heal-gaps`) or explicit
reindex / `pnpm run reindex`. Heavy rebuild remains job-scoped with SSE
progress.

## Cancel & resume

| Event | Behavior |
|-------|----------|
| Cancel import/reindex | Cooperative between items; row → `cancelled` |
| Server restart mid-import | Orphan `running` → `pending` if spool exists; else `failed` |
| Server restart mid-reindex | Orphan `running` → `pending` (keeps `processed`); next run skips already-embedded ids when profile matches |
| New Reindex/Rebuild | Recreates that provider’s vec table |
| Cancel mid-reindex | Leaves partial table; next *new* job wipes and rebuilds |

## MemAvailable refuse

On Linux, Indexes / `POST /api/search/reindex` use `/proc/meminfo` MemAvailable:

- **All providers refused** below ~512 MB free.
- **Large libraries** refused below ~1024 MB (Voyage/OpenAI/local) or
  ~1536 MB (Ollama).
- Soft warnings still appear when tight-but-allowed.
- HTTP refuse → **503** with the reason. Logs: `[search] …`.

## Orphan workers after Next restart

- Embedding rebuilds normally run in a **child** (`pnpm embedding-worker <id>`).
- The job row stores `worker_pid` when the child (or inline worker) starts.
- Restarting Next does **not** always kill an already-spawned child.
- On next open of Indexes / status, orphaned `running` rows are **reclaimed**:
  if `worker_pid` is alive and looks like `embedding-worker`, reclaim signals
  it (SIGTERM then SIGKILL) before re-queuing; if a live owned worker cannot be
  stopped, reclaim **defers** (leaves `running`) so a duplicate child is not
  spawned. Dead / missing PID → re-queue or cancel as before.
- Check `ps` for leftover `embedding-worker` / `tsx … embedding-worker` if WAL
  stays locked.
- Import jobs are in-process: restart drops the runner; reclaim uses the spool.

## Env knobs (infra only)

| Variable | Role |
|----------|------|
| `INSTAGRAM_SAVES_DB` | SQLite path (default under `data/`) |
| `INSTAGRAM_SAVES_KEYRING=memory` | Tests / headless (no OS keyring) |
| `INSTAGRAM_SAVES_LOCAL_TOKEN` | Optional; when set, mutating API routes require this token |
| `NEXT_PUBLIC_INSTAGRAM_SAVES_LOCAL_TOKEN` | Same value as above for the browser UI (only if token mode is on) |
| `EMBEDDING_WORKER_INLINE=1` | Run rebuilds in-process (tests) |
| `EMBEDDING_WORKER_MAX_OLD_SPACE_MB` | Child heap cap (default **2048**); replaces inherited `--max-old-space-size` |
| `NODE_OPTIONS` | Parent may set a large heap; worker spawn overrides max-old-space-size |
| `__NEXT_DISABLE_MEMORY_WATCHER=1` | Next.js escape hatch if the framework memory watcher interferes with long imports/rebuilds (set only if you hit that) |

## Files & backup

| Path | Contents |
|------|----------|
| `data/instagram-saves.db` (+ `-wal`/`-shm`) | Library, jobs, settings, FTS/vec |
| `data/imports/` | Upload spools (deleted when import finishes) |

Backup: stop the app, copy the `.db` and any `-wal`/`-shm`. Restore the same
way. **Reset library** (Settings danger zone) wipes content/indexes but keeps
`app_settings` and keyring secrets.

## Smoke / bench (no live reindex)

```bash
pnpm exec tsc --noEmit
pnpm test:parse
pnpm test:unit -- src/lib/parse/property.test.ts   # R3 property-parse (fast-check)
pnpm bench:smoke   # synthetic parse / IN() chunk / zip-cap timings — no real DB, no Voyage/Ollama
pnpm bench:scale   # R3 scale smoke (2k); full 50k: BENCH_SCALE_N=50000 pnpm bench:scale
pnpm soak:scale    # R3 soak smoke (1k likes→temp DB+FTS); full: SOAK_N=250000 pnpm soak:scale
```

Do **not** run `pnpm reindex` or live embedding against a real user DB while
validating quality gates.

## Soak / chaos plan (R2 durability)

Acceptance for crash-safety claims (Beyond A+ / Phase 6). Run these offline —
no Voyage/Ollama, no real user DB.

### Documented scenarios

| Scenario | How to exercise | Pass criteria |
|----------|-----------------|---------------|
| SIGKILL mid-embed | Vitest `src/lib/fault-inject.test.ts` — leave `embedding_jobs` `running` with `processed < total`, reclaim as after restart | Job → `pending` with **processed preserved**; `PRAGMA integrity_check` = `ok` |
| SIGKILL mid-import write | Same suite — committed batch rows + `import_jobs` `running`; reclaim with/without spool | Spool present → `pending`; missing spool → `failed`; integrity_check = `ok`; committed rows remain |
| Vec integrity beyond counts | Vitest `src/lib/search/vec-integrity.test.ts` + Indexes status | Orphan vec rows / width drift demote health; `integrityOk` on provider status |
| Streaming-extract RSS | `pnpm bench:smoke` (CI gate) | Peak RSS delta on synthetic zip extract stays under budget |

### Operator manual checks

```bash
pnpm test:unit -- src/lib/fault-inject.test.ts src/lib/search/vec-integrity.test.ts
pnpm bench:smoke
# optional on a copy of the library DB (stop the app first):
sqlite3 data/instagram-saves.db 'PRAGMA integrity_check;'
```

### Scale baselines (R3)

| Scenario | How to exercise | Pass criteria |
|----------|-----------------|---------------|
| Property parser mutations | `pnpm test:unit -- src/lib/parse/property.test.ts` | fast-check suite green (fixed seed); parsers never throw on garbage / mutated trees |
| 50k+ RSS / wall-time | Smoke: `pnpm bench:scale` (N=2k). Full: `BENCH_SCALE_N=50000 pnpm bench:scale` | Smoke hard-fails on wall/RSS budgets; full run prints JSON summary for contracts paste (no multi-hour soak) |
| 250k synthetic soak | Smoke: `pnpm soak:scale` (N=1k). Full: `SOAK_N=250000 pnpm soak:scale` | Temp DB import + FTS reindex + `integrity_check`; smoke budgets hard-fail; full numbers for release notes |

Paste full-run `[bench-scale] json …` / `[soak-scale] json …` lines into release notes
or `docs/contracts.md` Beyond A+ when recording a machine baseline.

Beyond-A+ scale work: see `docs/contracts.md` and remaining-work tracker R3.
