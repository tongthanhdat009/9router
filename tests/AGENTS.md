<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-12 | Updated: 2026-08-12 -->

# tests

Vitest test suite for the dashboard/gateway. An **independent ESM package** — has its own `package.json`, resolves `open-sse`/`@/` aliases via `tests/vitest.config.js` regardless of where vitest lives, and is NOT wired into root `npm test`.

## Purpose

Data-driven coverage of the provider/translator surface + unit tests for routing, OAuth, token refresh, quota, and auth flows. Catches regressions caused by the OpenAI-intermediate-format translation bridge and provider registry changes.

## Key Files

| File | Description |
|------|-------------|
| `vitest.config.js` | Resolves `open-sse`/`@/` aliases; auto-discovers tests here |
| `package.json` | Tests' own deps (vitest). Committed `test` script is a Unix-only shared-install workaround — ignore it, use `npx vitest run` |
| `README.md` | Test docs |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `unit/` | 164 unit tests: routing, oauth, token refresh, quota, auth, providers |
| `translator/` | Translation-layer tests (see `translator/AGENTS.md` — hand-authored, detailed) |
| `__baseline__/` | Regression baselines: providers/alias/OAuth-url snapshots + `verify-*.mjs` comparators + `known-fails.txt` |

## For AI Agents

### Working In This Directory
- Run from `tests/`: `npx vitest run` (all) or `npx vitest run unit/capabilities.test.js` (single file, path relative to `tests/`).
- **The suite is NOT expected to be all-green on a plain checkout** (~938 pass, ~64 fail). Expected red: 26 catalogued in `__baseline__/known-fails.txt`, `unit/embeddings.cloud.test.js` (imports `cloud/` dir not in this repo), `unit/xai-oauth-service.test.js` (timeout when xAI discovery unreachable), `real/*.real.test.js` (need live credentials).
- Judge regressions with `tests/__baseline__/verify-no-regression.mjs`, never a raw run.
- `tests/translator/registerAll.js` is required by any test calling `translateRequest`/`translateResponse` — `require()` silently no-ops under vitest/ESM without it (false pass).
- Run `verify-*.mjs` after touching provider registry / alias logic.

### Testing Requirements
- Always pass `--config tests/vitest.config.js` so aliases resolve.
- `RUN_REAL=1` gates live-provider tests (`translator/real/`).
- Bug-exposure tests use `it.fails(...)`; fixing a bug turns the case RED → switch to `it` and verify.

### Common Patterns
- Data-driven: `matrix.js` reads `PROVIDER_MODELS` directly — new provider/models get covered automatically.

## Dependencies

### Internal
- `open-sse/translator/`, `open-sse/config/` — system under test
- `src/` (imports need root deps: `open`, `undici`, …)

### External
- vitest

<!-- MANUAL: -->
