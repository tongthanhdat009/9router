<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-12 | Updated: 2026-09-22 -->

# src

## Purpose

The Next.js app side of 9Router: dashboard UI, `/v1` OpenAI-compatible API tree, auth guard, persistence, and OAuth/credential management. App-side glue to the provider-agnostic routing engine in `open-sse/` — `src/sse/` handlers parse/expand requests, then delegate to `open-sse/handlers/chatCore.js`. All local state lives in one SQLite file via `src/lib/db/`; `localDb.js`, `usageDb.js`, `disabledModelsDb.js` are pure re-export shims. Auth boundaries: `dashboardGuard.js` (edge) + `src/sse/services/auth.js` (endpoint).

## Key Files

| File | Description |
|------|-------------|
| `proxy.js` | Next `proxy` export → `dashboardGuard.js`. Matcher EXCLUDES `(api/)v1/chat/completions` (~0.5-0.8ms saved); that route self-guards via `guardPublicLlmApi` |
| `dashboardGuard.js` | Auth gate: JWT `auth_token` cookie (jose, `lib/auth/dashboardSession.js`), API keys (`Bearer`/`x-api-key`/`x-goog-api-key`/`?key` vs SQLite `apiKeys`), CLI `x-9r-cli-token` (machine id), localhost trust (`x-9r-real-ip` + `x-9r-via-proxy` + `trustedPeer` + Origin check) |
| `instrumentation.js` | Server boot (nodejs runtime): `initConsoleLogCapture` + `installCatalogSource` (`open-sse/providers/catalogOverride.js`) + `startModelCatalogSync` (`@/lib/modelCatalog/sync.js`) |
| `lib/localDb.js` / `lib/usageDb.js` / `lib/disabledModelsDb.js` (+`models/index.js`) | Pure re-export shims of `@/lib/db/index.js` — no logic, no bypass; `usage.json` is only a `LEGACY_FILES` migration source in `lib/db/paths.js` |
| `lib/db/driver.js` | SQLite adapter chain: `bun:sqlite` → `better-sqlite3` → `node:sqlite` → `sql.js` |
| `lib/db/paths.js` | DB location: `<DATA_DIR>/db/data.sqlite` (DATA_DIR else `~/.9router`) |
| `lib/db/repos/*.js` | Per-entity DB access (settings, connections, combos, aliases, apiKeys, pricing, usage…) |
| `sse/handlers/chat.js` | Chat entry: parse body, combo/fusion expansion, account-selection loop, capacity adapter → `open-sse/handlers/chatCore.js` |
| `sse/services/auth.js` | Endpoint-level auth: provider credential lookup, API-key validation |
| `sse/services/tokenRefresh.js` | Upstream OAuth token refresh + `updateProviderCredentials` |
| `mitm/manager.js` / `server.js` | MITM proxy manager + server for IDE provider interception |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `app/` | Next App Router: `app/api/*` (dashboard + `/v1` compat API trees), `app/(dashboard)/dashboard/*` UI, `app/landing`, `app/login`, `app/callback` (see `app/AGENTS.md`) |
| `sse/` | App-side handlers per modality + services. Glue to `open-sse/` — directory-only container (see `sse/AGENTS.md`) |
| `lib/` | Persistence + infra: `db/`, `oauth/` (25 flows), `tunnel/`, `network/`, `mcp/`, `pxpipe/`, `qoder/`, `headroom/`, `updater/`, `auth/` (+`saml.js`, `trustedPeer.js`), `modelCatalog/`, monitors (see `lib/AGENTS.md`) |
| `shared/` | Browser+server shared code: `components/`, `constants/` (+`index.js`), `hooks/`, `services/`, `utils/` (+`index.js`) |
| `mitm/` | MITM proxy for IDE providers (cursor, copilot, kiro, antigravity): `manager.js`, `server.js`, `handlers/`, `cert/`, `dns/` |
| `i18n/` | Runtime i18n: `config.js`, `runtime.js`, `RuntimeI18nProvider.js` |
| `store/` | Zustand stores: headerSearch, notification, provider, settings, theme, user |
| `models/` | DB-model re-export entry (`index.js`) |

## For AI Agents

### Working In This Directory

- Plain JavaScript (ESM), no TypeScript. `@/*` → `src/*`.
- **`src/` ↔ `open-sse/` boundary**: `src/sse/` is app-side glue; the engine lives in `open-sse/`. Read `open-sse/AGENTS.md` before touching routing/translation logic.
- Request flow: `/v1/*` rewrite (`next.config.mjs`) → `app/api/v1/*` route → `sse/handlers/chat.js` → `open-sse/handlers/chatCore.js` → SSE back.
- **Persistence is SQLite** (`src/lib/db/`). Import from `@/lib/db/index.js` — the three shims are backward-compat only. Schema/migrations in `src/lib/db/migrations/`.
- `dashboardGuard.js` = edge auth; `src/sse/services/auth.js` = endpoint auth. Two layers — do not conflate.
- `custom-server.js` (repo root) derives client IP from the TCP socket and strips attacker-controlled `X-Forwarded-For`; `dashboardGuard.isLocalRequest` trusts `x-9r-real-ip`. Preserve when touching request/IP/rate-limit code.
- `src/lib/db/repos/` and `src/app/api/*` route trees mirror entity names — look for an existing repo/route before writing new DB access.

### Testing Requirements

- Tests live in `tests/` (independent ESM package): `cd tests && npx vitest run` — NOT wired into root `npm test`.
- Suite is NOT all-green on a plain checkout. Judge regressions with `tests/__baseline__/verify-no-regression.mjs`; expected red catalogued in `tests/__baseline__/known-fails.txt` (86 entries; `tests/unit/` holds 263 test files).
- Run `tests/__baseline__/verify-*.mjs` after touching provider registry / alias logic.
- `*.real.test.js` make live provider calls — skip unless credentials are set.

### Common Patterns

- DB access: go through `src/lib/db/repos/<entity>Repo.js`; never raw SQL in route handlers.
- API routes: `src/app/api/<entity>/…/route.js` handlers call a `src/lib/db/repos/` or `src/lib/oauth/` function, return JSON via `NextResponse`.
- OAuth providers: one file per provider under `src/lib/oauth/providers/`, wired through `src/lib/oauth/services/`.
- Auth checks: `verifyDashboardAuthToken` for JWT; `validateApiKey` for API keys; `getConsistentMachineId` for the CLI token.
- Client state: Zustand stores in `src/store/`; shared browser logic in `src/shared/`.

## Dependencies

### Internal

- `open-sse/` — routing/translation engine (`open-sse/handlers/chatCore.js`, `open-sse/services/combo.js`)
- `custom-server.js` (repo root) — `x-9r-real-ip`/`x-9r-via-proxy` headers consumed by `dashboardGuard.js`
- `next.config.mjs` — `/v1/*` → `/api/v1/*` rewrite into `src/app/api/v1/*`

### External

- Next.js — App Router, API routes, `next/server`
- `bun:sqlite` / `better-sqlite3` (optional) / `node:sqlite` / `sql.js` — DB adapter chain
- `zustand` — client stores (`src/store/`); `undici` / `open` — runtime deps

<!-- MANUAL: -->
