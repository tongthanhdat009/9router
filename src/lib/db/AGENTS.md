<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-12 | Updated: 2026-08-12 -->

# src/lib/db

## Purpose

The SQLite persistence layer for 9Router — the single source of truth for settings, provider connections/nodes, proxy pools, api keys, combos, model aliases (incl. mitm), pricing, disabled models, usage history/daily, and request details. Everything was migrated from `db.json`-style flat files into one `data.sqlite` DB, accessed only through `db/repos/*`. The DB file lives at `<DATA_DIR>/db/data.sqlite`.

## Key Files

| File | Description |
|------|-------------|
| `index.js` | Public API barrel — re-exports every repo function (the `@/lib/db/index.js` import target) |
| `driver.js` | Adapter chain, runtime-aware: Bun → `bun:sqlite` → `sql.js`; Node → `better-sqlite3` (optional) → `node:sqlite` (≥22.5) → `sql.js` (pure-JS, always works). Cached on `global._dbAdapter` to survive hot reload; runs migrations once on first init |
| `schema.js` | `TABLES` + `buildCreateTableSql` + `SCHEMA_VERSION` — canonical DDL |
| `migrate.js` | Migration runner + legacy JSON import (db.json/usage.json/disabledModels.json/request-details.json). `MigrationAborted` rolls back on row-count assertion failure; marker file `.migrated-from-json` prevents re-import |
| `version.js` | `getAppVersion` (from package.json), `timestampSlug` (backup naming) |
| `backup.js` | Best-effort safety backups ONLY before schema changes — no automated restore (manual copy-back). Excludes `requestDetails` (auto-pruned); keeps newest `KEEP_BACKUPS` (3) |
| `paths.js` | `DB_DIR`/`DATA_FILE` (`<DATA_DIR>/db/data.sqlite`), `BACKUPS_DIR`, `LEGACY_FILES` map; `ensureDirs()` |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `adapters/` | One adapter per SQLite impl: `bunSqliteAdapter.js`, `betterSqliteAdapter.js`, `nodeSqliteAdapter.js`, `sqljsAdapter.js` (same interface, swapped by `driver.js`) |
| `helpers/` | `jsonCol.js` (JSON column (de)serialization), `kvStore.js` (namespaced key/value via `kv` table), `metaStore.js` (`_meta` table get/set) |
| `migrations/` | Migration registry — `index.js` + numbered files (`001-initial.js`). Append new entries, unique monotonically-increasing versions |
| `repos/` | Per-entity DB access: alias, apiKeys, combos, connections, disabledModels, nodes, pricing, proxyPools, requestDetails, settings, usage |

## For AI Agents

### Working In This Directory

- **Entry point is `index.js`** — import `@/lib/db/index.js`, never the adapters directly.
- Adapter interface is uniform (create → `get`/`run`/`all` etc.); write against the interface, not one driver. Never assume a specific SQLite binding is present — `better-sqlite3` is optional by design.
- Migration flow: `driver.initAdapter` → `runMigrationOnce(adapter)` → apply pending `MIGRATIONS` entries, then legacy-JSON import for first boot. Add new migrations to `migrations/` with a monotonic version — don't hand-edit `schema.js` tables out of band.
- Repos mirror entity names of `src/app/api/*` routes — check for an existing repo before writing new SQL.
- Usage + request logs persist in SQLite (`usageHistory`/`usageDaily`); `appendRequestLog` is effectively a no-op (logs are derived from history on read). `usageRepo` keeps in-memory state (`pendingRequests`, `statsEmitter`) on `global.*` for hot-reload survival.
- Backups exclude `requestDetails` on purpose (observability log, auto-pruned, non-critical) — don't "fix" that.
- Row-count assertions during migration are the data-loss guard — never weaken them.

### Testing Requirements

- Tests live in `tests/` (independent ESM package): `cd tests && npx vitest run` from repo root.
- Suite is NOT all-green on a plain checkout (~938 pass / ~64 fail). Judge regressions with `tests/__baseline__/verify-no-regression.mjs`, not a raw run.
- After touching provider registry / alias logic, run `tests/__baseline__/verify-*.mjs`.
- Migration changes: verify a fresh-DB boot (no legacy files) AND a legacy-JSON import path both work.

### Common Patterns

- New entity: create `repos/<entity>Repo.js` (functions taking an adapter from `getAdapter()`), export from `index.js`, call from routes via `@/lib/db/index.js`.
- JSON-ish columns: `parseJson`/`stringifyJson` from `helpers/jsonCol.js`.
- Scoped key/value state: `makeKv(scope)` from `helpers/kvStore.js`.
- Meta/migration state: `getMeta`/`setMeta` from `helpers/metaStore.js`.

## Dependencies

### Internal

- `@/lib/dataDir.js` — `DATA_DIR` for `paths.js`
- `@/lib/db/helpers/*` — jsonCol, kvStore, metaStore
- `@/lib/db/adapters/*` — loaded lazily by `driver.js`
- `@/lib/db/migrations/*` — applied by `migrate.js`

### External

- `bun:sqlite` (Bun), `better-sqlite3` (optional native dep), `node:sqlite` (Node ≥22.5), `sql.js` (pure-JS fallback)
- `node:fs`, `node:path`

<!-- MANUAL: -->
