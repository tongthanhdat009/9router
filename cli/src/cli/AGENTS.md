<!-- Parent: ../../AGENTS.md -->
<!-- Generated: 2026-08-12 | Updated: 2026-08-12 -->

# cli
## Purpose
Logic for the `9router` CLI launcher (published separately from the dashboard): terminal UI, HTTP client to the local server, interactive menus for apiKeys/cliTools/combos/providers/settings, xAI video command, and the system tray.

## Key Files
| File | Purpose |
|---|---|
| `terminalUI.js` | Terminal UI rendering/input |
| `api/client.js` | HTTP client to the local 9Router server |
| `commands/xaiVideo.js` | xAI video generation command |
| `menus/settings.js` | Settings menu |

## Subdirectories
| Directory | Contents |
|---|---|
| `api/` | client.js (HTTP client) |
| `commands/` | xaiVideo.js |
| `menus/` | apiKeys, cliTools, combos, providers, settings |
| `tray/` | tray, trayWin, autostart, tray.ps1 |
| `utils/` | clipboard, display, endpoint, format, input, menuHelper, modelSelector |

## For AI Agents
### Working In This Directory
This is the CLI package (`cli/`, npm `9router`) — independently versioned from the root dashboard. Changes here ship via `npm run cli:pack`. Talk to the server only through `api/client.js`, never raw HTTP.
### Testing Requirements
No automated suite; validate by running `cd cli && npm run dev` (nodemon watch) against a running local server. Read `cli/AGENTS.md` (parent) for package build/versioning rules.
### Common Patterns
Interactive flows build on `terminalUI.js` + `menus/*`; reusable input/format helpers live in `utils/`.

## Dependencies
### Internal
Local server HTTP API (dashboard), `cli/` package
### External
Node, npm tray/autostart tooling (OS-specific)
<!-- MANUAL: -->
