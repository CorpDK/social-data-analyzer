# Frozen contracts (Gate B+ guardrails)

Behavior contracts for import and embedding jobs. Refactors must preserve these
shapes and event names unless this doc is updated in the same change.

## Smoke baseline

```bash
pnpm exec tsc --noEmit
pnpm test:parse
```

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

## Import jobs (`import_jobs` / `ImportJobRecord`)

States: `pending` | `running` | `completed` | `failed` | `cancelled`  
Phases: `queued` | `received` | `extracting` | `inferring_schemas` | `parsing_saves` | `parsing_likes` | `writing` | `indexing` | `completed` | `failed`  
Kinds: `zip` | `json`

Progress details may include: `filesScanned`, `jsonFiles`, `schemasInferred`,
`itemsParsed`, `likesParsed`, add/update/skip counts, `importId`.

Zip extract fails closed on per-entry uncompressed size and total extracted-JSON
budget (`ImportZipSafetyError` → failed import with a clear message). Peak RAM
from full spool + AdmZip + all JSON strings is still a known residual (streaming
extract is a separate Gate B+ item).

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
