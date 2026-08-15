<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-15 | Updated: 2026-08-15 -->

# services

## Purpose
Provider/model/account selection, combo fallback, token refresh, capacity adaptation, usage, and provider-specific model discovery.

## Key Files
| File | Purpose |
|---|---|
| `model.js` / `provider.js` | Parse model IDs and resolve provider behavior/capabilities |
| `combo.js` / `accountFallback.js` | Multi-route and multi-account selection/fallback |
| `oauthCredentialManager.js` / `tokenRefresh.js` | OAuth refresh eligibility and refresh flow |
| `capacityAdapter.js` | Capacity-aware route adaptation |

## For AI Agents
### Working In This Directory
- Preserve failure hierarchy: executor retry → account fallback → combo/provider fallback; do not skip or restart the existing loop.
- Models/aliases remain config-driven; use `config/providerModels.js` and registry metadata rather than hardcoding.
- Token refresh decisions must be conservative; callers depend on `shouldRefreshCredentials`/credential-manager behavior.

### Testing Requirements
- Run focused unit tests for fallback/refresh changes plus regression baseline for model/registry changes.

### Common Patterns
- Services are pure-ish orchestration; persistence belongs in `src/lib/db/`, upstream calls in executors.

## Dependencies
### Internal
- `open-sse/config/`, `providers/`, `executors/`, `src/lib/db/`
### External
- None
