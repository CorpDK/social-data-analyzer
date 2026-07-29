# Instagram Saves

Local Next.js app that imports official Instagram data exports, stores saved posts/reels in SQLite, and lets you browse/analyze them. Re-importing newer exports merges new items and skips duplicates.

## Features

- Upload Instagram JSON exports (`.zip` or `.json`)
- SQLite persistence (`data/instagram-saves.db`)
- Deduping by media shortcode (and identical file content hash)
- Periodic re-imports: adds new saves, updates metadata/collections, skips unchanged
- Overview stats, filters by type/creator/collection

## Setup

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

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
- adm-zip for archive extraction

## Notes

- This uses Meta's official data download only — not the live Instagram API (saved posts are not exposed there).
- Media CDN URLs inside exports can expire; the app stores Instagram permalinks.
- Database files under `data/` are local-only and gitignored.
