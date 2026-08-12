<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-12 | Updated: 2026-08-12 -->

# shared
## Purpose
Client + shared code for the Next.js dashboard. UI primitives and app chrome (modals, layout, headers, sidebars), plus constants, hooks, bootstrap services, and utilities used across the app. Anything not tied to a single feature or to the SSE/mitm layers lives here.

## Key Files
| File | Purpose |
|---|---|
| `constants/providers.js` | Provider definitions/display metadata (mirrors `open-sse/providers/registry`) |
| `constants/config.js` | App-wide config constants |
| `services/bootstrap.js` / `initializeApp.js` | Client bootstrap / app init sequence |
| `utils/api.js` | API client helpers |
| `utils/ssrfGuard.js` | SSRF protection for fetch of user-supplied URLs |
| `utils/machineId.js` / `machine.js` | Machine identity helpers |
| `components/index.js` | Barrel re-export of all UI components |

## Subdirectories
| Directory | Contents |
|---|---|
| `components/` | 47 UI primitives + `layouts/` (AuthLayout, DashboardLayout): Modal, Drawer, Header, Sidebar, Button, Input, Select, Toggle, Tooltip, Badge, Card, Footer, Pagination, Loading, OAuthModal, CursorAuthModal, KiroAuthModal, EditConnectionModal, ModelSelectModal, PricingModal, UsageStats, RequestLogger, ProviderIcon, NineRemoteButton, … |
| `constants/` | cliTools, colors, config, coworkPlugins, locales, mitmToolHosts, models, providersDisplay, providers, skills, ttsProviders |
| `hooks/` | useCopyToClipboard, useModelCaps, useTheme |
| `services/` | bootstrap, initializeApp, quotaAutoPing |
| `utils/` | api, apiKey, bulkAdd, clineAuth, cn, connectionStatus, machineId, machine, providerCustomModels, providerIcon, providerModelsFetcher, ssrfGuard |

## For AI Agents
### Working In This Directory
Shared code — changes ripple to every dashboard screen. Reuse an existing component/util before adding a new one; check `components/index.js` and `utils/index.js` barrels first. Keep UI components presentational (props-driven), not coupled to stores.
### Testing Requirements
Component/utils changes should not break the vitest suite under `tests/` (imports via `@/shared/…`). Run the relevant test file after touching shared logic.
### Common Patterns
Components: named export + barrel re-export in `components/index.js`. Class names via `utils/cn.js`. Constants: single-source-of-truth exports, imported elsewhere via `@/shared/constants/…`.

## Dependencies
### Internal
`src/store/` (zustand stores), `src/lib/db/`, `open-sse/` provider metadata
### External
React, next, zustand
<!-- MANUAL: -->
