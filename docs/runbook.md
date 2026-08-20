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

## Greenfield database bootstrap (ME-3)

SQLite `SCHEMA_VERSION 10` is the first Drizzle Kit-managed generation.
Migrations under `drizzle/sqlite/` run automatically when the app opens an
empty database. Existing versions 1–9 and unstamped non-empty databases are
intentionally rejected; stop the app, delete the configured SQLite file
(default `data/instagram-saves.db`, including its `-wal` / `-shm` companions),
restart, and perform a fresh import.

Schema authors generate reviewed migration files with:

```bash
pnpm db:generate
```

Use `pnpm db:generate:sqlite` or `pnpm db:generate:postgres` when changing only
one dialect. Do not run generated SQL manually against the SQLite app database.

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
