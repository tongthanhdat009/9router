<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-15 | Updated: 2026-09-22 -->

# services

## Purpose
Provider/model/account selection, combo rotation and fallback, token refresh, capacity adaptation, off-peak windows, usage/quota fetchers, thought-signature persistence, and provider-specific model discovery.

## Key Files
| File | Purpose |
|---|---|
| `model.js` / `provider.js` | Parse model IDs and resolve provider behavior/capabilities |
| `combo.js` | Combo routes; `getRotatedModels(models, comboName, strategy, stickyLimit = 1, rotationScope = null)` (combo.js:208) does per-session deterministic rotation |
| `accountFallback.js` | Multi-account selection/fallback |
| `oauthCredentialManager.js` / `tokenRefresh.js` + `tokenRefresh/` | OAuth refresh eligibility/flow; `tokenRefresh/` adds `dedup.js` + per-provider `providers.js` |
| `capacityAdapter.js` | Capacity-aware route adaptation |
| `usage.js` + `usage/` | Usage/quota plumbing; `usage/` holds per-provider fetchers (codex, claude, zed, kiro, muse, zcode, glm, grok-cli + `grokCliQuotaFrame.js`, plus `misc.js`/`shared.js`) |
| `offpeak/zcode.js` | ZCode off-peak window handling |
| `cursorModels.js` / `kiroModels.js` / `qoderModels.js` / `copilotModels.js` / `grokCliModels.js` / `kimchiModels.js` / `clinepassModels.js` | Per-provider model discovery |
| `zcodeKey.js` | ZCode coding-plan API key auto-provisioning |
| `thoughtSignatureStore.js` | KV store for provider thought signatures (capped 2000 entries) |
| `projectId.js` | Provider project-ID resolution |

## For AI Agents
### Working In This Directory
- Preserve failure hierarchy: executor retry → account fallback → combo/provider fallback; do not skip or restart the existing loop.
- Models/aliases remain config-driven; use `config/providerModels.js` and registry metadata rather than hardcoding.
- Token refresh decisions must be conservative; callers depend on `shouldRefreshCredentials`/credential-manager behavior.
- There is no compact module here — request compaction lives elsewhere; do not import services for it.

### Testing Requirements
- Run focused unit tests for fallback/refresh changes plus regression baseline for model/registry changes.

### Common Patterns
- Services are pure-ish orchestration; persistence belongs in `src/lib/db/`, upstream calls in executors.
- New provider quota/model-discovery = one `usage/<provider>.js` or `<provider>Models.js` module wired from its executor, not inlined logic.

## Dependencies
### Internal
- `open-sse/config/`, `providers/`, `executors/`, `utils/proxyFetch.js`, `src/lib/db/` (KV helpers)
### External
- None
