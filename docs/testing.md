# Testing

How to run and where to put tests for this repo.

## Quick commands

| Script | What it runs |
|--------|----------------|
| `pnpm test` / `pnpm test:unit` | Vitest unit + component tests (`src/**/*.test.ts(x)`) |
| `pnpm test:parse` | Legacy tsx integration suites under `scripts/tests/` (temp SQLite; no live reindex / Voyage / Ollama) |
| `pnpm test:e2e` | Playwright smoke / UI (`e2e/*.spec.ts`) against `http://127.0.0.1:3000` |
| `pnpm test:all` | Unit + parse (local convenience; CI splits jobs) |

```bash
pnpm test:unit
pnpm test:parse
# e2e: either start the app first, or let Playwright start `pnpm dev`
pnpm test:e2e
```

## Layout convention

**Colocated Vitest files** next to the code under test:

- `src/**/*.test.ts` — pure lib / helpers
- `src/**/*.test.tsx` — React components (RTL + jsdom)

Shared Vitest setup and MSW live under `src/test/` (`setup.ts`, `msw/`).

**Playwright** lives in `e2e/` (`*.spec.ts`). Optional fixtures: `e2e/fixtures/` (reuse `scripts/fixtures/` when possible).

Do **not** put Vitest files in `e2e/` or Playwright specs under `src/`.

## Mocking policy

| Layer | Tool | Use for |
|-------|------|---------|
| Modules / Node deps | `vi.mock` / DI | Boundary stubs (Next navigation, keyring, DB modules) |
| HTTP / fetch / Route Handler clients | **MSW** (`src/test/msw`) | API shapes the UI or helpers call via `fetch` |
| UI behavior | **RTL** + `@testing-library/user-event` | What the user sees/does — prefer queries by role/text |
| Full browser flows | **Playwright** | Nav shell, import/upload, SSE settle — against a real Next process |

Storybook is **out of scope** for Phase 0. Prefer RTL over snapshot-heavy component catalogs.

### MSW notes

- Default handlers: `src/test/msw/handlers.ts`
- Server started in `src/test/setup.ts` (`onUnhandledRequest: "error"`)
- Override in a test with `server.use(http.get(...))`; handlers reset after each test

### Playwright notes

- `playwright.config.ts` sets `baseURL: http://127.0.0.1:3000`
- `webServer` runs `pnpm dev` when nothing is listening; `reuseExistingServer: true` so a local `pnpm dev` is reused
- First time: `pnpm exec playwright install chromium` (CI job installs browsers when the e2e job runs)
- Keep smoke minimal; grow coverage in later phases (import, reset, settings)
- Next may log an `allowedDevOrigins` / webpack-hmr warning when the browser hits `127.0.0.1` — cosmetic for smoke (shell still loads). Do **not** edit `next.config.ts` casually (mtime restarts Next); defer that tweak to a later pass if HMR under Playwright becomes painful.

## CI

- **unit** job: Vitest
- **check** job: `tsc` + `pnpm test:parse` (unchanged offline env)
- **e2e** job: Playwright chromium smoke (installs browsers; starts Next via webServer)

Never point unit/e2e/CI at live Voyage / Ollama / production DB for reindex.
