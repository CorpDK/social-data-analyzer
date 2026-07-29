# Instagram Saves

Local Next.js app that imports official Instagram data exports, stores saved posts/reels in SQLite, and lets you browse/analyze them. Re-importing newer exports merges new items and skips duplicates.

## Features

- Upload Instagram JSON exports (`.zip` or `.json`)
- SQLite persistence with **WAL** (`data/instagram-saves.db`)
- Hybrid search: **FTS5** keyword + **sqlite-vec** semantic (RRF merge)
- Live semantic providers: **local** (always), plus **OpenAI** / **Voyage** when API keys are set
- Light / dark / system theme (header switcher; preference in localStorage)
- Deduping by media shortcode (and identical file content hash)
- Periodic re-imports: adds new saves, updates metadata/collections, skips unchanged
- Overview stats, filters by type/creator/collection

## Setup

```bash
pnpm install
pnpm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Search index

Search always keeps offline layers: FTS5 keyword search and a deterministic
1024-dimension local feature-hash index. The local semantic model is weaker than
a hosted embedding model, but needs no network or secret.

OpenAI and Voyage are available in the UI only when their keys are configured.
Both can be live at once. On the **Saves** page, switch semantic provider with
the segmented control (or `?provider=openai|voyage|local`). The choice is stored
in localStorage and validated server-side; an unavailable provider falls back to
local and reports that in the response.

`EMBEDDING_PROVIDER` sets the default when no UI/URL override is present:

- `local` — offline local vectors
- `openai` — prefer OpenAI when `OPENAI_API_KEY` is set
- `voyage` — prefer Voyage when `VOYAGE_API_KEY` is set

If omitted, the app selects OpenAI when `OPENAI_API_KEY` is set, otherwise
Voyage when `VOYAGE_API_KEY` is set, otherwise local. Remote embedding and KNN
errors—including timeouts and network/5xx failures—fall back to the matching
local query vector and local document index. Remote and local vector spaces are
never mixed. Search reports `hybrid`/`vec` for the preferred path,
`hybrid-local-fallback`/`vec-local-fallback` after failover, and `fts` when only
keyword results are available.

`GET /api/search/providers` returns `{ available, configured, default }` without
leaking key values.

```bash
cp .env.example .env.local
# set OPENAI_API_KEY and/or VOYAGE_API_KEY
pnpm run reindex
```

OpenAI defaults to `text-embedding-3-small` at 1024 dimensions. Override its
model with `EMBEDDING_MODEL`; set `EMBEDDING_BASE_URL` to an OpenAI-compatible
base URL (default `https://api.openai.com/v1`) or full `/embeddings` URL.
`OPENAI_API_KEY` is used as the bearer token.

Voyage uses its native `https://api.voyageai.com/v1/embeddings` API with
`input_type=document` while indexing and `input_type=query` while searching.
Set `VOYAGE_API_KEY`; `VOYAGE_MODEL` defaults to the current cost/latency model
`voyage-4-lite`, with 1024 dimensions. Voyage's supported Matryoshka dimensions
are 256, 512, 1024, and 2048.

Local, OpenAI, and Voyage vectors all use the same fixed 1024 dimensions.
`EMBEDDING_TIMEOUT_MS` controls the remote request timeout (default 10000).
`pnpm run reindex` always rebuilds FTS and local vectors, and also rebuilds every
configured remote provider. `--remote` asserts that at least one remote key is
configured:

```bash
pnpm run reindex -- --remote
```

The database stores vectors in `saved_items_vec_local`, `saved_items_vec_openai`,
and `saved_items_vec_voyage` as needed (`FLOAT[1024]`), with separate provenance
metadata. A mismatch disables only that index path. Run `pnpm run reindex` after
changing a remote model or endpoint. Imports update FTS in their data
transaction, then write local vectors and attempt each configured remote index
after commit. No SQLite transaction is held over a network call, and remote
failures do not roll back the import or its offline search indexes.

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
5. Download the zip when Meta emails you, then upload it on the **Import** page

## Deduplication

| Layer | Behavior |
|-------|----------|
| File hash | Exact same zip/json content is recorded as `duplicate` and not re-applied |
| Media key | Shortcode from `/p/…`, `/reel/…`, `/tv/…` URLs is unique in SQLite |
| Re-import | Existing items get `last_seen_import_id` refreshed; new collections merge in |

## Stack

- Next.js (App Router)
- better-sqlite3 + Drizzle schema
- SQLite **WAL**, **FTS5**, and **sqlite-vec**
- adm-zip for archive extraction

## Notes

- This uses Meta's official data download only — not the live Instagram API (saved posts are not exposed there).
- Media CDN URLs inside exports can expire; the app stores Instagram permalinks.
- Database files under `data/` are local-only and gitignored (including `-wal` / `-shm`).
