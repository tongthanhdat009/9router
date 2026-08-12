<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-12 | Updated: 2026-08-12 -->

# cli

## Purpose

The `9router` CLI launcher — a standalone npm package (published as `9router`) that installs, starts, and manages the 9Router gateway. It resolves the standalone server build (bundled into `cli/app/` at pack time), kills stale 9router processes and port conflicts, spawns the server with the correct runtime env, shows an interface menu (browser / terminal UI / tray / exit), runs the system tray, and self-heals lazy-installed runtime deps (SQLite, systray) into `~/.9router/runtime`. It is versioned and built independently of the root package; its changelog entries are mirrored into the root `CHANGELOG.md`.

## Key Files

| File | Description |
|------|-------------|
| `package.json` | Package manifest: `bin` `9router` → `./cli.js`; scripts `dev` (nodemon), `build` (build-cli), `pack:cli`, `publish:cli`, `postinstall`; version independent of root (currently `0.5.50`) |
| `cli.js` | CLI entry (`#!/usr/bin/env node`): arg parsing (`--port/-p`, `--host/-H`, `--no-browser/-n`, `--log/-l`, `--tray/-t`, `--skip-update`, `--help`, `--version`), update check, process/port cleanup, server spawn + crash-restart, interface menu, tray init. `9router xai video` subcommand bypasses the launcher flow |
| `README.md` | npm-facing usage docs (install, quick start, CLI options, data location) |
| `.npmignore` | Inverts to whitelist: only `cli.js`, `hooks/`, `app/`, `package.json`, `README.md`, `LICENSE` ship |
| `LICENSE` | MIT |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `hooks/` | Postinstall + runtime self-heal for lazy deps (no deeper AGENTS.md yet) |
| `scripts/` | Build tooling: `build-cli.js`, `buildMitm.js` (no deeper AGENTS.md yet) |
| `src/` | CLI source: terminal UI, API client, menus, tray, utils (no deeper AGENTS.md yet) |

## For AI Agents

### Working In This Directory

- Plain JavaScript (CommonJS — this package is NOT ESM; root is ESM, `cli/` is CJS with `require`/`module.exports`).
- This is the launcher only — it never routes traffic. The gateway it starts is the root Next.js standalone build copied into `cli/app/` (see `scripts/build-cli.js`). Prefer root `src/` / `open-sse/` for routing changes.
- `cli/app/` (the standalone server bundle) is generated at build time by `scripts/build-cli.js` from the root app. Do not hand-edit it; it is the published artifact that `cli.js` spawns.
- Version bumps: edit `cli/package.json`, bump the changelog, and mirror the entry into root `CHANGELOG.md` (root and `cli/` are versioned independently). Conventional Commits.
- Runtime deps are deliberately NOT bundled: `sql.js` / `better-sqlite3` install into `~/.9router/runtime/node_modules` via `hooks/sqliteRuntime.js`, and `systray2` (macOS/Linux only) via `hooks/trayRuntime.js`. Windows uses PowerShell NotifyIcon (`trayWin.js`), zero binaries. Never add a native dep to `dependencies` — it breaks global updates (Windows EBUSY) and triggers AV false positives.
- Process cleanup in `cli.js` is carefully whitelisted (`node` + `9router` + `cli.js`/`next-server`) to avoid killing editors/grep/strace/cursor that merely match the name — preserve this when touching kill logic.

### Testing Requirements

- There is no test suite in `cli/` (verified: `find . -name "*test*"` returns nothing). Root `tests/` does not cover the CLI.
- Manual smoke check after any change: `cd cli && npm run dev` (nodemon watch), then `9router --version`, `9router --help`, and a real `9router` start against a built `app/` (`npm run cli:pack` from root builds the standalone bundle first).
- Before publishing: `npm run cli:pack` (build + `npm pack`) and inspect the tarball contents — `.npmignore` whitelists exactly what should ship.

### Common Patterns

- Subcommands early-return before launcher flow: `if (args[0] === "xai" && args[1] === "video")` → require + run + exit. Add new subcommands the same way (no runtime self-heal, no server spawn).
- Every cleanup/kill/probe is wrapped in try/catch and best-effort — never throw out of shutdown paths (`cleanup()`, `killByPidFile`, `waitServerReady`). `uncaughtException` is suppressed during shutdown.
- Tray abstraction: `tray/tray.js` is the cross-platform entry (systray on macOS/Linux), delegates to `trayWin.js` (PowerShell `tray.ps1`) on Windows; `tray/autostart.js` enables OS-boot startup.
- All dashboard state access from the CLI goes through `src/cli/api/client.js` (HTTP against the running gateway, token header `x-9r-cli-token` derived from machine ID). Menus in `menus/` call this client; shared prompt/display/menu helpers live in `utils/`.

## Dependencies

### Internal

- `../` root — `scripts/build-cli.js` builds the root Next.js app (standalone) into `cli/app/`, which `cli.js` then spawns. `hooks/` also reach the root build via `cli/app`. Root `package.json` exposes `cli:pack` / `cli:publish` proxying `cli/` scripts.
- The running server's state lives under `~/.9router` (`%APPDATA%\9router` on Windows) — see `hooks/sqliteRuntime.js` `getDataDir()`. CLI runtime deps land in `~/.9router/runtime/node_modules`.

### External

- `enquirer` — interactive prompts/menus
- `node-machine-id` — machine ID → CLI API token derivation
- `node-forge` — crypto utilities
- `react` / `react-dom` — bundled UI deps (satisfy root app build imports)
- Lazy-installed at postinstall/runtime: `sql.js`, `better-sqlite3` (optional), `systray2` (macOS/Linux only)
- Dev only: `esbuild` (bundling `buildMitm.js`), `nodemon` (`npm run dev` watch)

<!-- MANUAL: -->
