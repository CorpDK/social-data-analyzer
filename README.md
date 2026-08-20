# Instagram Saves

Local Next.js app that imports official Instagram data exports, stores saved posts/reels in SQLite, and lets you browse/analyze them. Re-importing newer exports merges new items and skips duplicates.

## Features

- Upload Instagram JSON exports (`.zip` or `.json`) as **background import jobs** (refresh-safe progress)
- SQLite persistence with **WAL** (`data/instagram-saves.db`)
- Browse **Saves** and **Likes** (posts/reels/stories/comments) from the same export
- Hybrid search on saves and likes: **FTS5** keyword + **sqlite-vec** semantic (RRF merge)
- Semantic providers: **Local (basic)** hasher, **Ollama**, **OpenAI**, **Voyage** — each explicitly enableable
- **Indexes** page: per-library (Saves / Likes) coverage/health + UI reindex with live progress
- Overview: top creators for saves and likes side-by-side
- Likes browser: Saved badge when the same media is also in saves (`media_key` / shortcode)
- Runtime config via **Settings** (keys → system keyring; enable flags / models / URLs → SQLite); env vars are optional CI fallbacks
- Light / dark / system theme (header switcher; preference in localStorage)
- Deduping by media shortcode (and identical file content hash)
- Periodic re-imports: adds new saves/likes, updates metadata/collections, skips unchanged
- Overview stats, filters by type/creator/collection
- **Schema explorer** (`/schemas`): structural schemas for every JSON file in imported zips (types/keys/nesting only — not row payloads or string samples). Aggregated **All** view or per-import by filename. Captured automatically on import into `import_schemas`; older imports need a re-import to populate.

## Setup

```bash
pnpm install
pnpm run dev
```

`pnpm dev` / `pnpm start` bind **127.0.0.1** only (LAN closed). Open
[http://127.0.0.1:3000](http://127.0.0.1:3000), then **Settings** to configure
providers. Mutating APIs enforce loopback Host/Origin (optional local token —
see [`docs/runbook.md`](docs/runbook.md)).

Operator checklist (import / reindex / cancel / MemAvailable / orphan workers /
heap env / local trust): see [`docs/runbook.md`](docs/runbook.md).

### Testing

```bash
pnpm test:unit    # Vitest (unit + RTL + MSW)
pnpm test:parse   # legacy tsx integration suites
pnpm test:e2e     # Playwright smoke (needs browsers; starts or reuses pnpm dev)
```

Conventions and mocking policy: [`docs/testing.md`](docs/testing.md).

### Search index

**FTS5 keyword search always stays on.** Vector indexes are separate and only
used when explicitly **enabled** in Settings (credentials alone do not count).

| Mode | Ready for search / reindex / import embed |
|------|-------------------------------------------|
| `local` | Enable Local for that library (default **on** for both). Offline hasher; no secret. |
| `ollama` | Enable Ollama for that library (default **off**) + running Ollama |
| `openai` | Enable OpenAI for that library (default **off**) + API key |
| `voyage` | Enable Voyage for that library (default **off**) + API key |

Enable flags live in SQLite `app_settings` as per-library keys
(`saves_local_enabled`, `likes_openai_enabled`, …). Legacy shared keys
(`local_enabled`, `openai_enabled`, …) still migrate: if the old flag was on,
both Saves and Likes stay enabled. Saving a key never flips enable to on.
Existing installs with keys stay disabled until you turn each index on.

On the **Saves** and **Likes** pages, the provider switcher lists only
providers enabled **for that library** (and usable). The choice is stored in
localStorage (separate keys per page) and validated server-side; a
disabled/unavailable provider falls back and reports that in the response.

**Settings → Preferred provider** (or env `EMBEDDING_PROVIDER`) sets the default
when no UI/URL override is present. Auto only considers providers enabled for
the current library (OpenAI → Voyage → Ollama → Local).

Remote embedding and KNN errors—including timeouts and network/5xx
failures—fall back to the matching local query vector and local document index.
Vector spaces are never mixed across providers. Search reports `hybrid`/`vec`
for the preferred path, `hybrid-local-fallback`/`vec-local-fallback` after
failover, and `fts` when only keyword results are available.

`GET /api/search/providers?library=saves|likes` returns
`{ library, available, configured, enabled, default }` without leaking key values.

### API keys & Settings

Prefer **Settings** in the nav. Configure:

| Setting | Persistence |
|---------|-------------|
| OpenAI / Voyage / optional Ollama API keys | OS keyring (`@napi-rs/keyring`) |
| Per-provider × library enable (Saves / Likes) | SQLite `app_settings` |
| OpenAI base URL & model | SQLite `app_settings` |
| Voyage model | SQLite `app_settings` |
| Ollama base URL / model | SQLite `app_settings` |
| Preferred provider & embedding timeout | SQLite `app_settings` |

The API never returns secret values to the browser after save—only configured
booleans / masked status. Changes apply on the next request (no restart).

If the keyring is unavailable (headless/CI), non-secret settings still save to
SQLite; API keys fall back to environment variables.

**Danger zone** (Settings): wipe all saves, likes, imports, collections, FTS, and
vector indexes via `POST /api/settings/reset-library` with body
`{ "confirmation": "DELETE ALL SAVES" }`. Keeps `app_settings` and keyring
secrets. Local single-user — the typed phrase is the deliberate safeguard.

```bash
# optional — only for CI/headless overrides; see .env.example
cp .env.example .env.local
pnpm run reindex
```

Defaults (editable in Settings):

- OpenAI: `https://api.openai.com/v1`, `text-embedding-3-small` at 1024 dims
- Voyage: native `https://api.voyageai.com/v1/embeddings`, `voyage-4-lite` at 1024 dims (`input_type=document` while indexing, `query` while searching)
- Ollama: `http://127.0.0.1:11434/v1`, `qwen3-embedding:0.6b` (pull with `ollama pull qwen3-embedding:0.6b`)
- Remote timeout: 10000 ms

All four providers use fixed 1024 dimensions. Vector tables:

- Saves: `saved_items_vec_local`, `saved_items_vec_ollama`, `saved_items_vec_openai`,
  `saved_items_vec_voyage`
- Likes: `liked_items_vec_local`, `liked_items_vec_ollama`, `liked_items_vec_openai`,
  `liked_items_vec_voyage`

Metadata profiles are keyed as `local` / `openai` / … for saves and
`likes-local` / `likes-openai` / … for likes. A profile mismatch drops that
library’s search to FTS-only for the mismatched provider.

`pnpm run reindex` always rebuilds FTS for both libraries, then every **enabled**
provider for saves and likes. `--remote` asserts that at least one neural
provider is enabled:

```bash
pnpm run reindex -- --remote
```

Or use **Indexes** in the nav (`/indexes`): dual **Saves indexes** / **Likes
indexes** sections with per-provider status and **Reindex** / **Rebuild**
buttons. Job targets are `local`… for saves and `likes-local`… for likes. Jobs
persist in SQLite (`embedding_jobs`); only one runs at a time, with additional
jobs queued as `pending`. **Reindex all configured** enqueues one job per
enabled provider × library (skipping targets that already have a
pending/running job). Cancel stops the active job only; queued jobs keep their
place. Cancel is cooperative between items. APIs:
`GET /api/search/status`, SSE `GET /api/search/status/stream`,
`POST /api/search/reindex`, `GET /api/search/reindex`,
`POST /api/search/reindex/cancel`.

**Resume:** If the server restarts mid-rebuild, the interrupted job is
re-queued as `pending` (keeping `processed`). The next run skips item ids
already present in that provider’s vec table when the stored profile still
matches Settings. A brand-new Reindex/Rebuild always recreates the vec table.
Cancel leaves a partial table; the next *new* job wipes and rebuilds.

**RAM / large libraries:** Status includes `host.memAvailableMb` (Linux). The
Indexes UI warns before large reindexes (≥20k items, or likes ≥5k) and when
estimated vector payload is high (stronger copy for Ollama). The server
**refuses all providers** when `MemAvailable` is below ~512 MB, and refuses
**large-library** rebuilds when below ~1024 MB (Voyage/OpenAI/local) or
~1536 MB (Ollama, local model RAM). Tight-but-allowed cases still soft-warn
in the UI. HTTP `POST /api/search/reindex` returns **503** with the refuse
message; Indexes shows Blocked + the same reason.

**Embedding worker:** Rebuilds normally run in a nice’d child process
(`pnpm embedding-worker <jobId>`, spawned by the job runner) so heavy embed
work is isolated from the Next.js UI event loop. The spawn sets
`NODE_OPTIONS=--max-old-space-size=2048` (override with
`EMBEDDING_WORKER_MAX_OLD_SPACE_MB`; existing `NODE_OPTIONS` flags are kept
and an already-set max-old-space-size is not overwritten). Progress still
updates `embedding_jobs` (SSE unchanged). Set `EMBEDDING_WORKER_INLINE=1` to
force in-process execution (tests do this via the memory keyring). On Linux,
systemd `MemoryMax=` on a unit wrapping the app is an optional extra OS
cap if you want hard cgroup limits.

After upgrading, run **Reindex all configured** (or `pnpm run reindex`) so likes
vector indexes are built — existing likes rows are not re-embedded automatically
until import changes or a reindex.
Imports run as durable **background jobs** (same in-process pattern as reindex):
`POST /api/import` spools the upload under `data/imports/`, inserts an
`import_jobs` row, returns **202** `{ jobId }`, and processes asynchronously.
Progress phases (`extracting` → `inferring_schemas` → `parsing_saves` →
`parsing_likes` → `writing` → `indexing`) persist in SQLite; the Import page
subscribes to `GET /api/import/jobs/stream` (SSE). Cancel via
`POST /api/import/jobs/cancel`.
After a server restart, orphaned `running` jobs re-queue if the spool file
still exists, otherwise they fail clearly. Spool files are deleted when a job
finishes.

Imports update FTS per item write, then update vectors only for **enabled**
indexes after the write phase. Disabled indexes are skipped even if keys
exist. No SQLite transaction is held over a network call.

### Theme

The header theme control switches **System / Light / Dark**. System follows
`prefers-color-scheme` until you pick an explicit mode. Preference is stored in
localStorage (`instagram-saves-theme`); a small boot script sets `data-theme`
before paint to avoid a flash.

## Getting an Instagram export

1. Instagram → **Settings** → **Accounts Center** → **Your information and permissions** → **Download your information**
2. Export your Instagram profile to device
3. Choose saved/activity data (or all information)
4. Set format to **JSON**
5. Download the zip when Meta emails you, then upload it on the **Import** page (max **512MB** zip via multipart — formData buffers in memory before spool; standalone `.json` also max **512MB** for Node string limits). You can leave or refresh the page; the job keeps running and the progress panel catches up.

## Deduplication

| Layer | Behavior |
|-------|----------|
| File hash | Exact same zip/json content is recorded as `duplicate` |
| Media key | Shortcode from `/p/…`, `/reel/…`, `/tv/…` URLs is unique in SQLite |
| Re-import | Re-uploading the same export refreshes authors, saved dates, and collections on existing items (no duplicate rows). Overview stats update after re-import. |

### Export format notes

Recent Instagram JSON exports (2024+) often store saved posts in `string_list_data`
instead of `string_map_data`, with the creator username in `title` or
`string_list_data[].value`. Collections may use a flat list in
`saved_saved_collections` (collection header rows without URLs, followed by items).

If you imported before parser support for these shapes, **re-upload the same zip**
on the Import page — metadata will backfill without wiping your library.

## Stack

- Next.js (App Router)
- better-sqlite3 + Drizzle ORM / Drizzle Kit migrations
- SQLite **WAL**, **FTS5**, and **sqlite-vec**
- `@napi-rs/keyring` for OS credential storage
- adm-zip for archive extraction

## Notes

- This uses Meta's official data download only — not the live Instagram API (saved posts are not exposed there).
- Media CDN URLs inside exports can expire; the app stores Instagram permalinks.
- Database files under `data/` are local-only and gitignored (including `-wal` / `-shm`). Import spools under `data/imports/` are also gitignored.
- Infra-only env vars (not in Settings): `INSTAGRAM_SAVES_DB`, `INSTAGRAM_SAVES_KEYRING=memory` for tests, `EMBEDDING_WORKER_INLINE=1`, `EMBEDDING_WORKER_MAX_OLD_SPACE_MB` (default 2048).
- SQLite applies pending Drizzle migrations on open. Generate reviewed dialect migrations with `pnpm db:generate`; `SCHEMA_VERSION` marks intentional greenfield compatibility breaks rather than routine schema changes.
- Schema explorer stores lightweight type trees in `import_schemas` (`import_id`, `file_path`, `schema_json`, sizes). Import parses each JSON file fully (no byte truncation); arrays sample up to 20 elements (first / last / random middle) for element shapes. Existing `import_schemas` rows are not upgraded automatically — re-import to refresh schemas.
