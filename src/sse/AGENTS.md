<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-12 | Updated: 2026-08-16 -->

# sse
## Purpose
App-side glue between the Next.js `/v1/*` API routes and the provider-agnostic `open-sse` routing engine. Parses requests, expands model combos, selects accounts, translates client ↔ provider formats, and streams responses back — delegating the core routing logic to `open-sse/handlers/chatCore.js`.

## Key Files
| File | Purpose |
|---|---|
| `handlers/chat.js` | Main chat entry: parse, combo expansion, affinity selection/fallback + JSONL terminal diagnostics → `open-sse` chatCore |
| `services/sessionAffinity.js` | Process-local route/account bindings: 30-min TTL, route cap 4096, account cap 8192; never persist or synthesize identity |
| `services/auth.js` | Endpoint auth |
| `services/tokenRefresh.js` / `backgroundTokenRefresh.js` | OAuth token refresh |
| `utils/logger.js` | Logging |

## Subdirectories
| Directory | Contents |
|---|---|
| `handlers/` | chat (main), embeddings, fetch, imageGeneration, search, stt, tts, videoGeneration |
| `services/` | auth, model, sessionAffinity, tokenRefresh, backgroundTokenRefresh |
| `utils/` | logger |

## For AI Agents
### Working In This Directory
This is the app-side boundary: `src/sse/` is app glue; `open-sse/` is the engine. Cross the boundary consciously — read `open-sse/AGENTS.md` before touching engine behavior. New translators self-register in `open-sse/translator/`, not here. Affinity is hard invariants: stable client-origin identity only (no deriveSessionId/ephemeral/hashing), executor retry → account fallback → combo fallback, bindings local-evicting (no Redis/SQLite/distributed locks), `src/lib/affinityLogger.js` JSONL is the only diagnostics channel at 77ccaae1.
### Testing Requirements
The vitest suite under `tests/` exercises this layer (`tests/unit/`, `tests/translator/`). Judge regressions with `tests/__baseline__/verify-no-regression.mjs` — the suite is not expected all-green on a plain checkout.
### Common Patterns
Handlers mirror one OpenAI-compatible endpoint each; parsing/expansion lives in `handlers/chat.js`, translation in `open-sse/translator/*`.

## Dependencies
### Internal
`open-sse/` engine, `src/lib/db/`, `src/shared/`
### External
next (route handlers), SSE streaming
<!-- MANUAL: -->
