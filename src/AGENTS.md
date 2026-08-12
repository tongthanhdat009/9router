<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-12 | Updated: 2026-08-12 -->

# src

## Purpose

The Next.js app side of 9Router: dashboard UI, `/v1` OpenAI-compatible API tree, auth guard, persistence, and OAuth/credential management. Serves as the app-side glue to the provider-agnostic routing engine in `open-sse/` — `src/sse/` handlers parse/expand requests, then delegate to `open-sse/handlers/chatCore.js`. Owns all local state (SQLite via `src/lib/db/`, usage logs via `src/lib/usageDb.js`) and the auth boundaries (`dashboardGuard.js`, `src/sse/services/auth.js`).

## Key Files

| File | Description |
|------|-------------|
| `proxy.js` | Next `proxy` export: routes everything through `dashboardGuard.js` (matcher excludes `_next/static`, `_next/image`, favicon) |
| `dashboardGuard.js` | Auth middleware: public-path allow-list, `/v1*` API-key/CLI-token gate, JWT dashboard protection, localhost-only gates, `x-9r-real-ip` trust |
| `instrumentation.js` | Next instrumentation: `initConsoleLogCapture` (log buffer) on nodejs runtime |
| `models/index.js` | DB-model re-export shim (providers, nodes, combos, aliases, api keys…) → `@/lib/localDb` |
| `i18n/config.js` | Locale/config setup for runtime i18n |
| `shared/services/bootstrap.js` / `initializeApp.js` | App startup: DB hooks, tunnel watchdog, MITM, outbound proxy, quota pings |
| `lib/localDb.js` | **Backward-compat shim** — re-exports `@/lib/db/index.js`. New code imports `@/lib/db/` directly |
| `lib/db/driver.js` | SQLite adapter chain: `bun:sqlite` → `better-sqlite3` → `node:sqlite` → `sql.js` (pure-JS fallback) |
| `lib/db/paths.js` | DB location: `<DATA_DIR>/db/data.sqlite` (DATA_DIR else `~/.9router`); legacy-file map |
| `lib/db/repos/*.js` | Per-entity DB access (settings, connections, combos, aliases, apiKeys, pricing, usage…) |
| `lib/usageDb.js` | **Shim** → `@/lib/db/index.js` (usage/logs). Usage + request logs now persist in SQLite `usageHistory`/`usageDaily` tables; `appendRequestLog` is a no-op (logs derived from history on read) |
| `sse/handlers/chat.js` | Chat entry: parse body, combo/fusion expansion, account-selection loop, capacity adapter → `open-sse/handlers/chatCore.js` |
| `sse/services/auth.js` | Endpoint-level auth: provider credential lookup, API-key validation |
| `sse/services/tokenRefresh.js` | Upstream OAuth token refresh + `updateProviderCredentials` |
| `mitm/manager.js` / `server.js` | MITM proxy manager + server for IDE provider interception |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `app/` | Next App Router: `app/api/*` (dashboard + `/v1` compat API trees), `app/(dashboard)/dashboard/*` UI, `app/landing`, `app/login`, `app/callback` (see `app/AGENTS.md`) |
| `sse/` | App-side handlers per modality (chat, embeddings, fetch, image, search, stt, tts, video) + services (auth, model, tokenRefresh, backgroundTokenRefresh). **Glue to `open-sse/`** — no top-level files, directory-only container (see `sse/AGENTS.md`) |
| `lib/` | Persistence + infra: `db/` (SQLite), `oauth/` (24 provider files), `tunnel/` (cloudflare, tailscale), `network/` (outbound proxy), `mcp/` (stdioSseBridge), `pxpipe/`, `qoder/`, `headroom/`, `updater/`, `auth/`, `usageDb.js` (see `lib/AGENTS.md`) |
| `shared/` | Browser+server shared code: `components/` (46 UI components + layouts), `constants/`, `hooks/`, `services/`, `utils/` (machineId…) |
| `mitm/` | MITM proxy for IDE providers (cursor, copilot, kiro, antigravity): `manager.js`, `server.js`, `handlers/`, `cert/`, `dns/` |
| `i18n/` | Runtime i18n: `config.js`, `runtime.js`, `RuntimeI18nProvider.js` |
| `store/` | Zustand stores: headerSearch, notification, provider, settings, theme, user |
| `models/` | DB-model re-export entry (`index.js`) |

## For AI Agents

### Working In This Directory

- Plain JavaScript (ESM), no TypeScript. `@/*` → `src/*`.
- **`src/` ↔ `open-sse/` boundary**: `src/sse/` is app-side glue; the engine lives in `open-sse/`. Read `open-sse/AGENTS.md` before touching routing/translation logic.
- Request flow: `/v1/*` rewrite (`next.config.mjs`) → `app/api/v1/*` route → `sse/handlers/chat.js` (parse, combo expansion, account selection) → `open-sse/handlers/chatCore.js` → SSE back.
- **Persistence is SQLite** (`src/lib/db/`), not `db.json`. Import from `@/lib/db/index.js`, not `@/lib/localDb.js` (shim, backward-compat only). Per-entity logic in `src/lib/db/repos/*`; schema/migrations in `src/lib/db/migrations/`.
- Usage + request logs persist in SQLite (`usageHistory`/`usageDaily`, via `lib/db/repos/usageRepo.js`) under `<DATA_DIR>/db/data.sqlite`. `lib/usageDb.js` is a shim — `usage.json` survives only as a legacy-migration ref in `lib/db/paths.js`.
- Security env: `JWT_SECRET` (session cookie), `API_KEY_SECRET`, `MACHINE_ID_SALT`. `INITIAL_PASSWORD` default `123456` — must override.
- `dashboardGuard.js` = dashboard/API auth gate; `src/sse/services/auth.js` = endpoint auth. Two layers — don't conflate.
- `custom-server.js` (repo root) derives client IP from the TCP socket and strips attacker-controlled `X-Forwarded-For`; `dashboardGuard.isLocalRequest` trusts `x-9r-real-ip`. Preserve when touching request/IP/rate-limit code.
- `src/lib/db/repos/` and `src/app/api/*` route trees mirror entity names — look for an existing repo/route before writing new DB access.

### Testing Requirements

- Tests live in `tests/` (independent ESM package): `cd tests && npx vitest run` — from repo root, NOT wired into root `npm test`.
- Suite is NOT all-green on a plain checkout (~938 pass / ~64 fail). Judge regressions with `tests/__baseline__/verify-no-regression.mjs`, not a raw run. Expected red catalogued in `tests/__baseline__/known-fails.txt`.
- Run `tests/__baseline__/verify-*.mjs` after touching provider registry / alias logic.
- `*.real.test.js` make live provider calls — skip unless credentials are set.

### Common Patterns

- DB access: go through `src/lib/db/repos/<entity>Repo.js`; never raw SQL in route handlers.
- API routes: `src/app/api/<entity>/…/route.js` handlers call a `src/lib/db/repos/` or `src/lib/oauth/` function, return JSON via `NextResponse`.
- OAuth providers: one file per provider under `src/lib/oauth/providers/`, wired through `src/lib/oauth/services/`.
- Auth checks: use `verifyDashboardAuthToken` for JWT; `validateApiKey` for API keys; `getConsistentMachineId` for the CLI token.
- Client state: Zustand stores in `src/store/`; shared browser logic in `src/shared/`.

## Dependencies

### Internal

- `open-sse/` — routing/translation engine; `src/sse/` imports it (e.g. `open-sse/handlers/chatCore.js`, `open-sse/services/combo.js`)
- `custom-server.js` (repo root) — `x-9r-real-ip`/`x-9r-via-proxy` headers consumed by `dashboardGuard.js`
- `next.config.mjs` — `/v1/*` → `/api/v1/*` rewrite that routes traffic into `src/app/api/v1/*`

### External

- Next.js — App Router, API routes, `next/server`
- `bun:sqlite` / `better-sqlite3` (optional) / `node:sqlite` / `sql.js` — DB adapter chain (`src/lib/db/driver.js`)
- `zustand` — client stores (`src/store/`)
- `undici` / `open` — runtime deps (via root, needed for imports/tests)

<!-- MANUAL: -->
