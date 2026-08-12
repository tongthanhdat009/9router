<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-12 | Updated: 2026-08-12 -->

# store
## Purpose
Zustand client-side state stores for the dashboard: header search, notifications, provider/settings/theme/user state. Single-file stores, barrel-exported from `index.js`.

## Key Files
| File | Purpose |
|---|---|
| `index.js` | Barrel re-export of all stores |
| `providerStore.js` | Provider configuration state |
| `settingsStore.js` | App settings state |
| `userStore.js` | Current-user state |
| `themeStore.js` | Theme state |

## Subdirectories
(none)

## For AI Agents
### Working In This Directory
Each store is one small file — add state as a new store file + `index.js` re-export, or extend the matching store. Keep stores UI-state only; persisted/entity data lives in `src/lib/db/`.
### Testing Requirements
Store logic is thin; changes surface through `tests/` components tests. No store-specific suite — run the relevant component test if behavior changed.
### Common Patterns
Zustand `create()` per store; selectors consumed via hooks in `src/shared/components/`; barrel export from `index.js`.

## Dependencies
### Internal
`src/shared/`
### External
zustand
<!-- MANUAL: -->
