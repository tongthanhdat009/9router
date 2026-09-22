<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-12 | Updated: 2026-09-22 -->

# sse

## Purpose

App-side glue between the Next.js `/v1/*` API routes and the provider-agnostic `open-sse` routing engine. Parses requests, expands model combos, selects accounts, translates client ↔ provider formats, and streams responses back — delegating core routing logic to `open-sse/handlers/chatCore.js`.

## Key Files

| File | Purpose |
|------|---------|
| `handlers/chat.js` | Main chat entry: parse, combo expansion, affinity selection/fallback + JSONL terminal diagnostics → `open-sse` chatCore |
| `services/sessionAffinity.js` | Process-local route/account bindings: 30-min TTL, route cap 4096, account cap 8192; never persist or synthesize identity |
| `services/auth.js` | Endpoint auth (provider credential lookup, API-key validation) |
| `services/tokenRefresh.js` / `backgroundTokenRefresh.js` | Upstream OAuth token refresh (inline + background loop) |
| `services/antigravityQuota.js` | Antigravity quota tracking service |
| `utils/logger.js` | Logging |

## Subdirectories

| Directory | Contents |
|-----------|----------|
| `handlers/` | chat (main), decisions, embeddings, fetch, imageGeneration, search, stt, tts, videoGeneration |
| `services/` | antigravityQuota, auth, backgroundTokenRefresh, model, sessionAffinity, tokenRefresh |
| `utils/` | logger |

## For AI Agents

### Working In This Directory

This is the app-side boundary: `src/sse/` is app glue; `open-sse/` is the engine. Cross the boundary consciously — read `open-sse/AGENTS.md` before touching engine behavior. New translators self-register in `open-sse/translator/`, not here. Affinity is hard invariants: stable client-origin identity only (no deriveSessionId/ephemeral/hashing), executor retry → account fallback → combo fallback, bindings local-evicting (no Redis/SQLite/distributed locks); `src/lib/affinityLogger.js` JSONL is the only diagnostics channel at `77ccaae1`.

### Testing Requirements

The vitest suite under `tests/` (`tests/unit/`, `tests/translator/`) exercises this layer. Judge regressions with `tests/__baseline__/verify-no-regression.mjs` — the suite is not all-green on a plain checkout (86 known-fail entries).

### Common Patterns

Handlers mirror one OpenAI-compatible endpoint each; parsing/expansion lives in `handlers/chat.js`, translation in `open-sse/translator/*`.

## Dependencies

### Internal

`open-sse/` engine, `src/lib/db/`, `src/shared/`

### External

next (route handlers), SSE streaming

<!-- MANUAL: -->
