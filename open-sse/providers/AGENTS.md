<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-15 | Updated: 2026-08-15 -->

# providers

## Purpose
Provider registry, capability/pricing metadata, and shared provider endpoint/header helpers.

## Key Files
| File | Purpose |
|---|---|
| `index.js` | Assembles/exports `PROVIDERS` |
| `registry/index.js` | Auto-generated static imports for registry files |
| `REGISTRY_TEMPLATE.js` | Starting point for one provider definition |
| `capabilities.js` / `pricing.js` | Provider/model capability and pricing helpers |

## For AI Agents
### Working In This Directory
- One provider per `registry/<id>.js`; copy `REGISTRY_TEMPLATE.js`, then add models in `open-sse/config/providerModels.js`.
- `registry/index.js` is generated — regenerate it; never hand-edit its import list.
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
