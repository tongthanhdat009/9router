<!-- Generated: 2026-08-12 | Updated: 2026-08-12 -->

# 9router

Local AI routing gateway + Next.js dashboard. Exposes one OpenAI-compatible endpoint (`/v1/*`) and routes traffic across 40+ upstream providers with format translation, model-combo fallback, multi-account fallback, OAuth/API-key credential management, token refresh, quota/usage tracking, and optional cloud sync.

Two published artifacts share this repo:
- **Dashboard + gateway** (`9router-app`, root `package.json`) — the Next.js server that does the actual routing.
- **CLI launcher** (`cli/`, npm `9router`) — installs/starts the server, manages the tray. Independent version + build.

## Key Files

| File | Description |
|------|-------------|
| `package.json` | Dashboard/gateway manifest + scripts |
| `next.config.mjs` | Next config; maps `/v1/*` → `/api/v1/*` rewrite |
| `custom-server.js` | Wraps Next standalone server; derives client IP from TCP socket, strips attacker `X-Forwarded-For` |
| `.env.example` | Full env contract (JWT_SECRET, API_KEY_SECRET, MACHINE_ID_SALT, …) |
| `jsconfig.json` | `@/*` alias → `src/*` |
| `eslint.config.mjs` | ESLint (extends eslint-config-next) |
| `CLAUDE.md` | Project guidance; architecture + persistence details |
| `Dockerfile` / `docker-compose.yml` / `DOCKER.md` | Container deployment |
| `start.sh` | Runtime launcher |
| `CHANGELOG.md` | Conventional-Commits changelog (root + cli versioned separately) |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `src/` | Next.js app: dashboard UI + `/v1` compat APIs (see `src/AGENTS.md`) |
| `open-sse/` | Provider-agnostic routing/translation engine (see `open-sse/AGENTS.md`) |
| `cli/` | npm `9router` launcher package (see `cli/AGENTS.md`) |
| `tests/` | Vitest suite (see `tests/AGENTS.md`) |
| `docs/` | Architecture + design docs (see `docs/AGENTS.md`) |
| `gitbook/` | GitBook site source, multi-language (see `gitbook/AGENTS.md`) |
| `scripts/` | Registry/migration/build tooling (see `scripts/AGENTS.md`) |
| `skills/` | 9router MCP-style skills (web fetch/search, image, tts, …) |
| `i18n/` | README translations |
| `public/` | Static assets + SW |
| `images/` | Screenshots |
| `.github/` | CI workflows + dependabot |

## For AI Agents

### Working In This Directory
- Plain JavaScript (ESM), no TypeScript. `@/*` → `src/*`.
- Read `docs/ARCHITECTURE.md` before request-flow work; `open-sse/AGENTS.md` before editing anything under `open-sse/`.
- State is SQLite under `src/lib/db/` (adapter fallback chain), NOT `db.json`. `src/lib/localDb.js` is a backward-compat shim — import from `@/lib/db/index.js`.
- `src/lib/usageDb.js` (`usage.json` + `log.txt`) still lives under `~/.9router`, not `DATA_DIR`.
- Affinity bindings are process-local in `src/sse/services/sessionAffinity.js`; diagnostics at `77ccaae1` are opt-in JSONL (`src/lib/affinityLogger.js`: `<DATA_DIR>/logs/affinity.jsonl`), not SQLite usage metadata.
- Commit style: Conventional Commits. Changelog in `CHANGELOG.md`.
- `custom-server.js` IP handling is security-sensitive — preserve it when touching request/IP/rate-limit code.

### Testing Requirements
- Tests live in `tests/` (independent ESM package, not wired into root `npm test`): `cd tests && npx vitest run`.
- Suite is NOT all-green on a plain checkout (~938 pass / ~64 fail). Judge regressions with `tests/__baseline__/verify-no-regression.mjs`, not a raw run.
- Run `tests/__baseline__/verify-*.mjs` after touching provider registry / alias logic.

### Common Patterns
- Providers self-register via `open-sse/providers/registry/*.js` + `config/providerModels.js`.
- Translators self-register via `register(from, to, reqFn, resFn)` import side-effect.
- Config-driven + DRY enforced by convention — never hardcode provider/model/role strings.

## Dependencies

### Internal
- `src/` ↔ `open-sse/` boundary: `src/sse/` is app-side glue; `open-sse/` is the engine. Cross consciously.

### External
- Next.js — dashboard + API routes
- `bun:sqlite` / `better-sqlite3` (optional) / `node:sqlite` / `sql.js` — DB adapter chain
- `undici` / `open` — runtime deps for tests/imports

<!-- MANUAL: Custom project notes can be added below -->
