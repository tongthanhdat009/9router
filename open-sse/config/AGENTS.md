<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-15 | Updated: 2026-08-15 -->

# config

## Purpose
Single source of routing constants: provider definitions, model/alias matrix, capabilities, runtime retries/timeouts, and format constants.

## Key Files
| File | Purpose |
|---|---|
| `providerModels.js` | Alias → provider/model matrix; add model capability metadata here |
| `runtimeConfig.js` | `HTTP_STATUS`, `RETRY_CONFIG`, `DEFAULT_RETRY_CONFIG`, timeouts/token limits |
| `providers.js` / `registry/` | Provider configuration used by registry assembly |

## For AI Agents
### Working In This Directory
- Config-driven only: never hardcode provider, model, role, retry, or endpoint strings in callers.
- Add provider models to `providerModels.js`; provider-specific behavior belongs in the registry definition, not a scattered special case.
- Retry changes affect `BaseExecutor.execute` globally; preserve per-status semantics and provider overrides.

### Testing Requirements
- Run `tests/__baseline__/verify-*.mjs` after provider/alias changes; matrix tests derive coverage from `PROVIDER_MODELS`.

### Common Patterns
- Export immutable constants/helpers; consumers import from here rather than duplicating values.

## Dependencies
### Internal
- Used by all `open-sse/` layers.
### External
- None
