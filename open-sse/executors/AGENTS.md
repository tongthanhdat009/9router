<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-15 | Updated: 2026-08-15 -->

# executors

## Purpose
Per-provider upstream call layer. One executor per non-standard provider; `DefaultExecutor` handles any OpenAI-compatible upstream. Subclass `BaseExecutor` for custom base URLs, headers, request transforms, or retry hooks.

## Key Files
| File | Purpose |
|---|---|
| `base.js` | `BaseExecutor`: `getBaseUrls`, `buildUrl`, `buildHeaders`, `transformRequest`, `shouldRetry`, `refreshCredentials`, `needsRefresh`, `parseError`, `execute` |
| `index.js` | Static map of instantiated executors (incl. aliases: `cu`→cursor, `gcli`/`gb`→grok-cli, `mmf`→mimo-free) + `getExecutor(provider)` (cached `DefaultExecutor` fallback) + `hasSpecializedExecutor` |
| `default.js` | `DefaultExecutor` — generic OpenAI-compatible path (also `openai-compatible-*` / `anthropic-compatible-*` base URL resolution) |

## For AI Agents
### Working In This Directory
- Only add an executor for a non-OpenAI-compatible upstream — generic providers use `DefaultExecutor` (via `getExecutor` fallback).
- Subclass `BaseExecutor` and override `getBaseUrls`/`buildHeaders`/`buildUrl`/`execute` (and optionally `computeRetryDelay`, `transformRequest`, `refreshCredentials`); register the instance in `index.js`.
- Retry config is per-status-key in `open-sse/config/runtimeConfig.js`; `BaseExecutor.execute` merges `DEFAULT_RETRY_CONFIG` with `this.config.retry`.
- Binary/protobuf upstreams (kiro EventStream, cursor protobuf, commandcode NDJSON) are handled entirely inside their own executor — they don't round-trip through `open-sse/translator/`.
- OAuth token refresh: implement `refreshCredentials`/`needsRefresh`; base uses `open-sse/services/oauthCredentialManager.js` `shouldRefreshCredentials`.

### Testing Requirements
- Covered via `tests/` unit tests (capabilities, provider matrix) + `tests/translator/real/*.real.test.js` live calls (skip unless credentials set).
- Run `tests/__baseline__/verify-*.mjs` after touching provider registry / alias logic.

### Common Patterns
- Executor = class extending `BaseExecutor` + instance registered in `index.js` map; aliases allowed (one instance, multiple keys).
- URL/header behavior stays config-driven via `this.config` (from `open-sse/config/providerModels.js`/registry) — never hardcode a provider URL.

## Dependencies
### Internal
- `open-sse/config/runtimeConfig.js` (HTTP_STATUS, RETRY_CONFIG), `open-sse/services/oauthCredentialManager.js`, `open-sse/utils/proxyFetch.js`, `open-sse/providers/shared.js`
### External
- `undici` (fetch), Node runtime
