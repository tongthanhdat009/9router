<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-15 | Updated: 2026-08-15 -->

# utils

## Purpose
Cross-engine stream/SSE/error handling, client detection, proxy fetch, session state, and binary protocol helpers.

## Key Files
| File | Purpose |
|---|---|
| `proxyFetch.js` | Proxy-aware fetch integration; side-effect may patch global fetch |
| `stream.js` / `streamHandler.js` / `sse.js` | Stream construction and SSE parsing/writing |
| `error.js` | Normalized upstream error helpers |
| `sessionManager.js` / `clientDetector.js` | Session and client-format detection. `sessionManager.js` owns `resolveClientAffinitySessionId`/`stableClientSessionId` (SESSION_HEADER_KEYS: `x-session-id`, `session-id`, `session_id`, `x-amp-thread-id`, `x-claude-code-session-id`, `x-session-affinity`, `x-mux-workspace-id`; body chain `prompt_cache_key`/`session_id`/`conversation_id`/`thread_id`); deliberately ignores router-generated ids — add new stable client headers there |
| `cursorProtobuf.js`, `cursorChecksum.js` | Cursor binary protocol helpers |

## For AI Agents
### Working In This Directory
- Preserve streaming backpressure and cancellation signals; don't buffer an SSE stream unless a converter explicitly needs it.
- `proxyFetch.js` is process-wide behavior — retain its import ordering/side effect.
- Session/client detection influences routing and affinity; require stable client-origin identities, never request-random fallbacks.
- Binary helpers are protocol-specific; do not route them through OpenAI-format translators.

### Testing Requirements
- Add focused unit coverage for parser/protocol changes; validate stream completion/error paths.

### Common Patterns
- Small stateless helper exports; keep provider-specific transforms in the provider executor.

## Dependencies
### Internal
- `open-sse/services/`, `translator/`, `executors/`
### External
- Web Streams, Node crypto/network APIs
