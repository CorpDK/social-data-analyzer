# Frozen contracts (Gate B+ guardrails)

Behavior contracts for import and embedding jobs. Refactors must preserve these
shapes and event names unless this doc is updated in the same change.

SQLite access ownership (Drizzle vs raw SQL): see `docs/db-boundary.md`.

## Smoke baseline

```bash
pnpm exec tsc --noEmit
pnpm test:parse
```

CI (`.github/workflows/ci.yml`) runs the same: `tsc --noEmit` + `pnpm test:parse`
with `INSTAGRAM_SAVES_KEYRING=memory` and `EMBEDDING_WORKER_INLINE=1` (no network,
no live reindex). Lint runs with `continue-on-error` until remaining debt is cleared.

Do **not** run `pnpm reindex`, Voyage, Ollama, or embedding jobs against a real
user library DB while validating contracts.

## SSE events (`src/lib/sse.ts`)

Shared helper: `createJobSseResponse`.

| Event       | When                                      | Payload                          |
|-------------|-------------------------------------------|----------------------------------|
| `snapshot`  | Initial connect + on publish / poll       | Full status object for the route |
| `idle`      | Queue idle after a snapshot (optional)    | Same snapshot shape              |
| `error`     | Stream failure                            | `{ message }` (or encode helper) |

Clients: `use-job-sse.ts` — backoff + `maxFailures`; close on `idle` when configured.

**Idle policy (intentional asymmetry):**
- Import stream: emits `idle` when the queue drains (upload form closes EventSource).
- Search status stream: does **not** emit `idle` — Indexes UI keeps watching
  coverage/health while idle.

**Fingerprints & idle cache (Gate A):**
- Change detection uses selected job/progress/coverage fields
  (`src/lib/sse-fingerprint.ts`), not `JSON.stringify` of the full snapshot.
- Search stream still sends the full snapshot payload on change; only the
  equality check is cheap.
- `getSearchIndexStatusForStream` caches expensive vec COUNTs for ~5s while
  **idle or active**, merging cheap job-queue fields between refreshes.
  Activity start/stop forces a full refresh so coverage updates promptly.
- Import progress DB writes are throttled (~1 Hz / every 50 items) like
  embedding jobs (`src/lib/progress-throttle.ts`).

## Import jobs (`import_jobs` / `ImportJobRecord`)

States: `pending` | `running` | `completed` | `failed` | `cancelled`  
Phases: `queued` | `received` | `extracting` | `inferring_schemas` | `parsing_saves` | `parsing_likes` | `writing` | `indexing` | `completed` | `failed`  
Kinds: `zip` | `json`

Progress details may include: `filesScanned`, `jsonFiles`, `schemasInferred`,
`itemsParsed`, `likesParsed`, add/update/skip counts, `importId`.

Zip extract streams from the spool path via yauzl (no full-spool
`readFileSync` + AdmZip). Each JSON entry is schema-inferred and parsed, then
dropped before the next (parse-and-drop). Per-entry / total JSON caps still
fail closed (`ImportZipSafetyError`). Import writes batch ~500 rows per
transaction (`IMPORT_WRITE_BATCH_SIZE`).

## Embedding jobs (`embedding_jobs`)

API may accept expanded targets; persisted rows use concrete targets such as
`saves-local`, `likes-openai`, etc. (see `EmbeddingJobTarget` / `formatJobTarget`).

States: `pending` | `running` | `completed` | `failed` | `cancelled`  
Phases follow rebuild progress (`preparing` | `fts` | `embedding` | `storing` | `done`).

Child worker: `NODE_OPTIONS --max-old-space-size` is set to
`EMBEDDING_WORKER_MAX_OLD_SPACE_MB` (default 2048) and **replaces** any inherited
parent heap cap (e.g. Next’s large `max-old-space-size`).

Id lookups for post-import embedding sync chunk `IN (...)` lists
(`SQL_IN_CLAUSE_BATCH_SIZE`, default 500) so imports adding >~32k items do not
hit SQLite bind-variable limits.

## Reindex targets

Library × provider indexes only (local / openai / voyage / ollama × saves / likes).
Legacy `all-configured` may still appear on old rows; new enqueues expand to
concrete targets.

## Settings key migration (Gate A / N3)

Shared provider enable keys (`local_enabled`, `ollama_enabled`, `openai_enabled`,
`voyage_enabled`) migrate once into per-library keys (`saves_*_enabled` /
`likes_*_enabled`) via `migrateLegacyProviderEnableKeys`, then are deleted.
Settings UI always reads/writes per-library keys. Env `*_ENABLED` fallbacks remain.

## Structured job logs (Gate A+)

One-line operator logs (throttled with progress publishes — not per item):

| Prefix | Source |
|--------|--------|
| `[import]` | Import runner (`src/lib/import/jobs.ts`) |
| `[search]` | Embedding job runner + memory refuse (`src/lib/search/jobs.ts`) |
| `[embedding-worker]` | Child worker entry (`scripts/embedding-worker.ts`) |

Fields when useful: `job=…`, `phase=…`, `processed/total`, short message.

## Base-URL trust (Gate A+ / D6)

Local-first, single-user, localhost. OpenAI/Ollama base URLs are fetched by the
local Node process. **No hard allowlist** (LAN Ollama must keep working). Soft
Settings hint for non-loopback / non-official-OpenAI hosts — see
`docs/runbook.md` and `src/lib/settings/base-url-trust.ts`.

## Operator runbook

Ops checklist (import, reindex, cancel/resume, MemAvailable, orphan workers,
heap env): `docs/runbook.md`.

Light synthetic bench (no real DB / no Voyage/Ollama): `pnpm bench:smoke`.

Parser edge fixtures (label_values / string_list quirks, collection-only,
malformed-recoverable): `scripts/fixtures/parse-edges/` via `pnpm test:parse`.

## Beyond A+ (optional backlog)

Not required for the A+ grade — track elsewhere if pursued:

- Fuller 50k+ import RSS / wall-time baseline (beyond `bench:smoke`)
- Fault injection (SIGKILL mid-embed / mid-import-write) + integrity_check
- Property-based parser mutations (fast-check)
- CI peak-RSS regression gate on the streaming-extract path
