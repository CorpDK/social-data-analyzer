# Instagram Saves

Local Next.js app that imports official Instagram data exports, stores saved posts/reels in SQLite, and lets you browse/analyze them. Re-importing newer exports merges new items and skips duplicates.

## Features

- Upload Instagram JSON exports (`.zip` or `.json`)
- SQLite persistence with **WAL** (`data/instagram-saves.db`)
- Hybrid search: **FTS5** keyword + **sqlite-vec** semantic (RRF merge)
- Semantic providers: **Local (basic)** hasher, **Ollama**, **OpenAI**, **Voyage** — each explicitly enableable
- **Indexes** page: per-provider coverage/health + UI reindex with live progress
- Runtime config via **Settings** (keys → system keyring; enable flags / models / URLs → SQLite); env vars are optional CI fallbacks
- Light / dark / system theme (header switcher; preference in localStorage)
- Deduping by media shortcode (and identical file content hash)
- Periodic re-imports: adds new saves, updates metadata/collections, skips unchanged
- Overview stats, filters by type/creator/collection
- **Schema explorer** (`/schemas`): structural schemas for every JSON file in imported zips (types/keys/nesting only — not row payloads). Aggregated **All** view or per-import by filename. Captured automatically on import into `import_schemas`; older imports need a re-import to populate.

## Setup

```bash
pnpm install
pnpm run dev
```

Open [http://localhost:3000](http://localhost:3000), then **Settings** to configure providers.

### Search index

**FTS5 keyword search always stays on.** Vector indexes are separate and only
used when explicitly **enabled** in Settings (credentials alone do not count).

| Mode | Ready for search / reindex / import embed |
|------|-------------------------------------------|
| `local` | Enable Local index (default **on**). Offline hasher; no secret. |
| `ollama` | Enable Ollama index (default **off**) + running Ollama |
| `openai` | Enable OpenAI index (default **off**) + API key |
| `voyage` | Enable Voyage index (default **off**) + API key |

Enable flags live in SQLite `app_settings` (`local_enabled`, `openai_enabled`,
`voyage_enabled`, `ollama_enabled`). Saving a key never flips enable to on.
Existing installs with keys stay disabled until you turn each index on.

On the **Saves** page, the provider switcher lists only **enabled + usable**
providers. The choice is stored in localStorage and validated server-side; a
disabled/unavailable provider falls back and reports that in the response.

**Settings → Preferred provider** (or env `EMBEDDING_PROVIDER`) sets the default
when no UI/URL override is present. Auto only considers enabled providers
(OpenAI → Voyage → Ollama → Local).

Remote embedding and KNN errors—including timeouts and network/5xx
failures—fall back to the matching local query vector and local document index.
Vector spaces are never mixed across providers. Search reports `hybrid`/`vec`
for the preferred path, `hybrid-local-fallback`/`vec-local-fallback` after
failover, and `fts` when only keyword results are available.

`GET /api/search/providers` returns `{ available, configured, enabled, default }`
without leaking key values.

### API keys & Settings

Prefer **Settings** in the nav. Configure:

| Setting | Persistence |
|---------|-------------|
| OpenAI / Voyage / optional Ollama API keys | OS keyring (`@napi-rs/keyring`) |
| Per-index enable (local / openai / voyage / ollama) | SQLite `app_settings` |
| OpenAI base URL & model | SQLite `app_settings` |
| Voyage model | SQLite `app_settings` |
| Ollama base URL / model | SQLite `app_settings` |
| Preferred provider & embedding timeout | SQLite `app_settings` |

The API never returns secret values to the browser after save—only configured
booleans / masked status. Changes apply on the next request (no restart).

If the keyring is unavailable (headless/CI), non-secret settings still save to
SQLite; API keys fall back to environment variables.

**Danger zone** (Settings): wipe all saves, imports, collections, FTS, and
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

All four vector indexes use fixed 1024 dimensions. Tables:
`saved_items_vec_local`, `saved_items_vec_ollama`, `saved_items_vec_openai`,
`saved_items_vec_voyage`.

`pnpm run reindex` always rebuilds FTS, then every **enabled** provider (local
when enabled, plus enabled neural indexes with credentials). `--remote` asserts
that at least one neural provider is enabled:

```bash
pnpm run reindex -- --remote
```

Or use **Indexes** in the nav (`/indexes`): per-provider status (coverage,
model/dimensions, health) and **Reindex** / **Rebuild** buttons with live
progress. Jobs persist in SQLite (`embedding_jobs`); only one runs at a time,
with additional per-provider jobs queued as `pending`. **Reindex all
configured** enqueues one job per enabled provider (skipping providers that
already have a pending/running job). Cancel stops the active job only; queued
jobs keep their place. Cancel is cooperative between items. APIs:
`GET /api/search/status`, `POST /api/search/reindex`, `GET /api/search/reindex`,
`POST /api/search/reindex/cancel`.

Imports update FTS in their data transaction, then update vectors only for
**enabled** indexes after commit. Disabled indexes are skipped even if keys
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
5. Download the zip when Meta emails you, then upload it on the **Import** page (max **2GB** — enough for full Meta exports that include media)

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
- better-sqlite3 + Drizzle schema
- SQLite **WAL**, **FTS5**, and **sqlite-vec**
- `@napi-rs/keyring` for OS credential storage
- adm-zip for archive extraction

## Notes

- This uses Meta's official data download only — not the live Instagram API (saved posts are not exposed there).
- Media CDN URLs inside exports can expire; the app stores Instagram permalinks.
- Database files under `data/` are local-only and gitignored (including `-wal` / `-shm`).
- Infra-only env vars (not in Settings): `INSTAGRAM_SAVES_DB`, `INSTAGRAM_SAVES_KEYRING=memory` for tests.
- Development schema changes apply on hot reload; bump `SCHEMA_VERSION` when adding or changing tables/indexes.
- Schema explorer stores lightweight type trees in `import_schemas` (`import_id`, `file_path`, `schema_json`, sizes). Large JSON files are sampled (first ~512KB) so giant message dumps still yield structure without keeping PII-heavy content.
