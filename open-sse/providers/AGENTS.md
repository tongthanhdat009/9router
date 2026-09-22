<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-15 | Updated: 2026-09-22 -->

# providers

## Purpose
Provider registry, capability/pricing metadata, thinking-level and vision heuristics, catalog overrides, and shared provider endpoint/header helpers.

## Key Files
| File | Purpose |
|---|---|
| `index.js` | Builds and exports `PROVIDERS`, `PROVIDER_MODELS`, `PROVIDER_OAUTH`, `PROVIDER_MEDIA` from registry entries (transport + models co-located) |
| `registry/` | 126 per-provider definition files, auto-imported by `registry/index.js` |
| `REGISTRY_TEMPLATE.js` | Starting point for one provider definition |
| `schema.js` | Entry schema + `PROVIDER_DEFAULTS` |
| `capabilities.js` / `pricing.js` / `shared.js` | Capability and pricing helpers, shared endpoint/header helpers |
| `thinkingLevels.js` | `getThinkingLevels` — per-model reasoning-effort levels |
| `visionPatterns.js` | Model-name vision-capability pattern matching |
| `catalogOverride.js` | Model-catalog override resolution |
| `models/` | Model-name parsing helpers: `schema.js`, `helpers.js`, `namePatterns.js` |

## For AI Agents
### Working In This Directory
- One provider per `registry/<id>.js`; copy `REGISTRY_TEMPLATE.js`, then add models in `open-sse/config/providerModels.js`.
- `registry/index.js` is generated (static imports for all registry files) — regenerate it; never hand-edit its import list.
- Generic OpenAI-compatible providers need no executor; add one only for non-standard protocol/transport.
- Keep display metadata aligned with `src/shared/constants/providersDisplay.js` through the supplied scripts.

### Testing Requirements
- Run `tests/__baseline__/verify-*.mjs` after registry or alias changes; inspect generated diff before committing.

### Common Patterns
- Provider metadata is declarative; endpoint/protocol transforms belong in an executor, not the registry.

## Dependencies
### Internal
- `open-sse/config/providerModels.js`, `open-sse/executors/`, `src/shared/constants/providersDisplay.js`
### External
- None
