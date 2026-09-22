<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-12 | Updated: 2026-09-22 -->

# src/lib

## Purpose

Server-side libraries for the 9Router gateway: persistence (SQLite layer in `db/`), OAuth/credential management (`oauth/`), remote-access tunneling (`tunnel/`), outbound proxy (`network/`), and app infrastructure (log buffer, data dir, updater, MCP bridge, headroom, model catalog). Owns no route handlers — `src/app/api/*` and `src/sse/*` call into here. All local state (settings, connections, combos, aliases, apiKeys, pricing, usage, request logs) persists in one SQLite file via `db/`.

## Key Files

| File | Description |
|------|-------------|
| `localDb.js` / `usageDb.js` / `disabledModelsDb.js` | **Pure re-export shims** of `@/lib/db/index.js` — no logic. New code imports `@/lib/db/index.js` directly |
| `mitmAliasCache.js` | NOT a DB shim — JSON read-replica of the SQLite `mitmAlias` map for the standalone MITM server (no SQLite native binding). Synced on app start and after every UI write; writes atomic via tmp+rename |
| `dataDir.js` | Resolves `DATA_DIR` (env) else `~/.9router` (Windows: `%APPDATA%/9router`); Unix path on Windows → fallback. Exports `DATA_DIR` |
| `consoleLogBuffer.js` | Console capture into a ring buffer (`CONSOLE_LOG_CONFIG.maxLines`), batched + ANSI-stripped, emitted via `EventEmitter` for the dashboard log viewer |
| `providerNormalization.js` | Provider-id normalization (`normalizeProviderId`, `isXaiModel`, `normalizeProviderSpecificData`) against `AI_PROVIDERS` |
| `affinityLogger.js` | Opt-in affinity JSONL: `ENABLE_AFFINITY_LOG=1` or `enableObservability`; `AFFINITY_LOG_FILE` override else `<DATA_DIR>/logs/affinity.jsonl`; redacts secrets/session/prompt fields |
| `modelCatalog/sync.js` | Model-catalog background sync (started from `src/instrumentation.js` via `startModelCatalogSync`) |
| `codexTransportMonitor.js` / `oauthRefreshMonitor.js` | Codex transport + OAuth-refresh diagnostic telemetry |
| `appUpdater.js` / `grokBuildConfig.js` | App-update check + Grok build config (version/binary URLs) |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `db/` | SQLite persistence layer: adapter chain, schema, migrations, per-entity repos (see `db/AGENTS.md`) |
| `oauth/` | Per-provider OAuth flows: 25 provider files + `_shared.js`, 15 services, PKCE/utils (see `oauth/AGENTS.md`) |
| `tunnel/` | Optional remote access via cloudflared / tailscale, watchdog + health checks (see `tunnel/AGENTS.md`) |
| `network/` | Outbound proxy: `outboundProxy.js`, `initOutboundProxy.js`, `connectionProxy.js` (auto-proxy env detection), `proxyTest.js` |
| `auth/` | Dashboard auth internals: `dashboardSession.js` (JWT via jose), `loginLimiter.js`, `oidc.js`, `saml.js` (@node-saml), `trustedPeer.js` |
| `headroom/` | Capacity headroom estimation: `detect.js`, `process.js` |
| `mcp/` | `stdioSseBridge.js` — MCP stdio ↔ SSE bridge for IDE clients |
| `pxpipe/` | Persisted-XPipe service: `events.js`, `install.js`, `loader.js`, `service.js` |
| `qoder/` | Qoder constants/encoding: `constants.js`, `cosy.js`, `encoding.js` |
| `updater/` | `updater.js` — app self-update logic |

## For AI Agents

### Working In This Directory

- Plain JavaScript (ESM), no TypeScript. `@/*` → `src/*`.
- **Persistence is SQLite** (`db/`), not `db.json`. Import from `@/lib/db/index.js`; the three shims are backward-compat only — never add exports there. Per-entity logic lives in `db/repos/*`.
- `db/driver.js` picks the SQLite adapter per runtime (Bun: `bun:sqlite` → `sql.js`; Node: `better-sqlite3` → `node:sqlite` ≥22.5 → `sql.js`). Do not depend on a specific driver.
- `mitmAliasCache.js` reads SQLite via `aliasRepo` but writes a JSON replica for the MITM process — DB is the source of truth; keep the two in sync.
- Tunnels (cloudflare/tailscale) import through the `@/lib/localDb` shim — changing DB entry points must keep those imports working.
- Do not re-implement provider-id normalization or data-dir resolution — use `providerNormalization.js` / `dataDir.js`.
- Route handlers must NOT do raw SQL — they call repo functions in `db/repos/`.

### Testing Requirements

- Tests live in `tests/` (independent ESM package): `cd tests && npx vitest run` from repo root.
- Suite is NOT all-green on a plain checkout. Judge regressions with `tests/__baseline__/verify-no-regression.mjs`; expected red in `tests/__baseline__/known-fails.txt` (86 entries).
- After touching provider registry / alias logic, run `tests/__baseline__/verify-*.mjs`.
- `*.real.test.js` make live provider calls — skip unless credentials are set.

### Common Patterns

- New DB access: add a repo under `db/repos/<entity>Repo.js`, export it from `db/index.js`, then import from `@/lib/db/index.js`.
- OAuth: one file per provider under `oauth/providers/`, wired through `oauth/services/`.
- Env-derived paths: use `dataDir.js` (`DATA_DIR`); never hardcode `~/.9router`.
- Log viewer data flows through `consoleLogBuffer.js` — capture, do not write your own logger.

## Dependencies

### Internal

- `@/shared/constants/*` — `AI_PROVIDERS` (`providerNormalization.js`), `CONSOLE_LOG_CONFIG` (`consoleLogBuffer.js`)
- `@/lib/db/` — all persistence; `@/lib/db/index.js` is the public API
- `@/mitm/manager` — tailscale manager calls `initDbHooks`/`getCachedPassword` for the MITM password store

### External

- Node/Bun runtime APIs — `node:sqlite` (Node ≥22.5), `bun:sqlite` (Bun), `node:fs`, `node:path`
- `better-sqlite3` (optionalDependencies — install never fails without build tools), `sql.js` (pure-JS fallback), `@node-saml` (SAML)
- `events` (EventEmitter), `open` / `undici` via root package

<!-- MANUAL: -->
