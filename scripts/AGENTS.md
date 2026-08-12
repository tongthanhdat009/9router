<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-12 | Updated: 2026-08-12 -->

# scripts

Build and registry-maintenance tooling for the dashboard/gateway.

## Purpose

Developer/build scripts: registry schema migrations, display-name injection, standalone-asset copying for the CLI bundle, live combo auto-switch testing, and README translation.

## Key Files

| File | Description |
|------|-------------|
| `copy-standalone-assets.mjs` | Copies traced assets into `.next/standalone` for the CLI's bundled server build |
| `migrate-registry.mjs` | Migrates all `open-sse/providers/registry/*.js` files to the Model-A schema (models[].kind, media promoted, terse format) |
| `injectDisplayToRegistry.mjs` | Injects display/category/uiAlias/extra from `src/shared/constants/providersDisplay.js` into each registry file |
| `test-combo-autoswitch.mjs` | Live test: sends text/image/search to a combo, reports which member ran (needs a running server) |
| `translate-readme.js` | Machine-translates README into `i18n/*` via GLM API |

## For AI Agents

### Working In This Directory
- `open-sse/providers/registry/index.js` is auto-generated — regenerate with these scripts, never hand-edit.
- ⚠️ `test-combo-autoswitch.mjs` contains a **hardcoded API key** (`sk-6581be4f05a82b6b-uxy6jn-c8190ea8`) as a default — replace with env before committing this script anywhere public.
- `translate-readme.js` makes paid API calls — respect env overrides (`GLM_API_ENDPOINT`, `GLM_API_MODEL`).

### Testing Requirements
- `migrate-registry.mjs` / `injectDisplayToRegistry.mjs` are destructive rewrites of registry files — run against a clean checkout and diff, then run `tests/__baseline__/verify-*.mjs` to catch snapshot drift.

### Common Patterns
- ESM `.mjs` (except the older `translate-readme.js`). `fileURLToPath` + `dirname` for self-location.

## Dependencies

### Internal
- `open-sse/providers/registry/`, `src/shared/constants/providersDisplay.js`, `i18n/`

### External
- GLM API (translate-readme)

<!-- MANUAL: -->
