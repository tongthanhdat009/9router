<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-12 | Updated: 2026-08-12 -->

# app

## Purpose

The Next.js App Router tree: two surfaces. The **API surface** under `app/api/*` exposes the `/v1/*` OpenAI-compatible endpoint (rewritten from `/v1/*` by root `next.config.mjs`) plus dashboard-internal routes (auth, oauth, cli-tools, models, providers, proxy-pools, pxpipe, headroom, tunnel, usage, settings…). The **UI surface** under `app/(dashboard)/dashboard/*`, `app/landing/`, `app/login/`, and `app/callback/` renders the dashboard and auth flows. Route handlers here are thin glue: they parse/auth, call `@/lib/…` or `@/sse/…` (which delegates to `open-sse/`), and return JSON via `NextResponse`.

## Key Files

| File | Description |
|------|-------------|
| `layout.js` | Root layout: Inter font, `globals.css`, ThemeProvider + RuntimeI18nProvider, Google Analytics. **Bootstraps the app on every request**: `initConsoleLogCapture`, outbound-proxy init, `@/shared/services/bootstrap` (initializeApp — DB hooks, tunnel watchdog, MITM), at module load |
| `globals.css` | Global stylesheet (theme tokens, base styles for the dashboard) |
| `page.js` | `/` → `redirect('/dashboard')` |
| `manifest.js` | PWA web-app manifest (name, icons, standalone display) |
| `favicon.ico` | Site favicon |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `api/` | All route handlers — see groups below. **`v1/` is the OpenAI-compatible surface**: `chat/completions`, `messages` (+`count_tokens`), `responses` (+compact), `embeddings`, `images/generations`, `videos` (edits/extensions/generations/`[id]`), `search`, `web/fetch`, `audio` (speech, transcriptions, voices), `models` (+`info`, `[kind]`), `api/chat`, `v1beta/models/[...path]`. Other groups: `auth/` (login, logout, status, reset-password, `oidc/` start-callback-test), `oauth/` (`[provider]/[action]` dynamic route + provider-specific: codex, cursor, gitlab/pat, iflow/cookie, kiro), `cli-tools/` (~17 per-CLI settings generators + antigravity-mitm/alias + all-statuses), `models/` (alias, availability, custom, disabled, test), `providers/` (client, `[id]`, kilo, suggested-models, test-batch, validate), `proxy-pools/` (cloudflare/deno/vercel-deploy, `[id]`), `pxpipe/` (health, install, logs, restart, start, stats, status, stop), `headroom/` (extras, proxy/`[...path]`, start/stop/status), `tunnel/` (enable/disable/status + tailscale-*), `usage/` (chart, history, logs, providers, request-details, request-logs, stats, stream, `[connectionId]`), `media-providers/tts/` (deepgram, elevenlabs, inworld, minimax, each +`/voices`), `mcp/` (`[plugin]/message`, `[plugin]/sse`), plus `combos/[id]`, `keys/[id]`, `provider-nodes`, `pricing`, `tags`, `translator/` (load/save/send/translate/console-logs), `settings/` (database, proxy-test, require-login), `version/` (shutdown/update), `init`, `health`, `shutdown`, `locale` |
| `(dashboard)/` | Route group for the logged-in UI (`dashboard/` inside): pages basic-chat, cli-tools (+components, `[toolId]`), combos, console-log, endpoint, media-providers (combo/`[id]`, `[kind]/[id]`, web), mitm, profile, providers (+components, `[id]`, new), proxy-pools, pxpipe, quota, skills, token-saver, translator, usage (+components/ProviderLimits) |
| `dashboard/` | Legacy non-group paths: `dashboard/settings` + `settings/pricing` |
| `landing/` | Public marketing page (`page.js` + components: HeroSection, Features, HowItWorks, FlowAnimation, GetStarted…) |
| `login/` | Login page |
| `callback/` | OAuth callback page |

## For AI Agents

### Working In This Directory

- Plain JavaScript (ESM), no TypeScript. `@/*` → `src/*`.
- Route handlers are **thin glue**: parse body, check auth (`dashboardGuard.js` in `src/proxy.js` guards the whole tree; per-route auth via `@/sse/services/auth.js`), call a `@/lib/db/repos/*` or `@/lib/oauth/*` function, return `NextResponse.json`. Look for an existing repo/route before writing new DB access.
- **`api/v1/*` = the public OpenAI-compatible surface.** `/v1/*` is rewritten to `/api/v1/*` by root `next.config.mjs`; keep compatibility semantics (OpenAI request/response shapes) when editing these routes. `responses/route.js` delegates to `@/sse/handlers/chat.js` → `open-sse/handlers/chatCore.js`.
- **Persistence is SQLite** (`@/lib/db/index.js`), not `db.json`. Import from `@/lib/db/index.js`, not the `@/lib/localDb.js` shim.
- Don't hand-edit `api/cli-tools/*` config templates' output shapes without checking the consuming CLI; they write real per-CLI config files.
- `app/page.js` is just a redirect; landing/login/callback are static pages — don't look for routing logic there.

### Testing Requirements

- Tests live in `tests/` (independent ESM package): `cd tests && npx vitest run`. Not wired into root `npm test`.
- Suite is NOT all-green on a plain checkout (~938 pass / ~64 fail). Judge regressions with `tests/__baseline__/verify-no-regression.mjs`, not a raw run; expected red in `tests/__baseline__/known-fails.txt`.
- API routes: verify manually via `curl` against the running server (`PORT=20128`) or via route-level tests in `tests/` — no dedicated app-route test harness.
- Run `tests/__baseline__/verify-*.mjs` after touching provider registry / alias logic.

### Common Patterns

- API route: `src/app/api/<entity>/…/route.js` exports `GET`/`POST` handlers → call `@/lib/db/repos/<entity>Repo.js` or `@/lib/oauth/providers`, return `NextResponse.json`.
- Dynamic routes: `[provider]/[action]` (oauth), `[plugin]` (mcp), `[id]` (usage, combos, keys, proxy-pools) — use `context.params` (await in Next 15 style).
- Auth: `verifyDashboardAuthToken` for JWT, `validateApiKey` for API keys, `getConsistentMachineId` for CLI token.
- Dashboard pages: client components use Zustand stores (`@/store`) and shared components (`@/shared/components`).
- Route group `(dashboard)/` must stay behind auth — don't add public pages there; use `landing/`/`login/` instead.

## Dependencies

### Internal

- `src/sse/` — `api/v1/*` routes delegate here (`sse/handlers/chat.js` for chat/responses, plus embeddings, images, videos, audio, search, fetch handlers)
- `src/lib/db/` — SQLite repos consumed by `api/*` route handlers (`@/lib/db/index.js`)
- `src/lib/oauth/` — provider credential flow consumed by `api/oauth/[provider]/[action]`
- `src/shared/` — `components/`, `services/` (bootstrap), `utils/` used by dashboard pages
- `src/` siblings — `proxy.js`/`dashboardGuard.js` guard this whole tree; `next.config.mjs` rewrites `/v1/*` into `api/v1/*`

### External

- Next.js — App Router, route handlers (`next/server` `NextResponse`), route groups, `next.config.mjs` rewrites
- `open-sse/` — routing/translation engine (indirect, via `src/sse/`)
- Google Analytics (`@next/third-parties/google`) + `material-symbols` + `next/font` in `layout.js`

<!-- MANUAL: -->
