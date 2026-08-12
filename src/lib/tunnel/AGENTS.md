<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-12 | Updated: 2026-08-12 -->

# src/lib/tunnel

## Purpose

Optional remote access for the 9Router local gateway — tunnels it behind either `cloudflared` (quick tunnel to a Cloudflare worker URL) or `tailscale` (funnel to the tailnet). Both services are spawned/managed/watched by their own `manager.js`, share health-check and watchdog timing, and gate on `getSettings`/`updateSettings` from `@/lib/localDb`. Public API is `index.js`.

## Key Files

| File | Description |
|------|-------------|
| `index.js` | Public API — re-exports cloudflare manager (enable/disable/status), cloudflared binary control (`killCloudflared`, `ensureCloudflared`, `getDownloadStatus`), tailscale manager, tailscale binary control (`installTailscale`, `startLogin`, `startFunnel`…), and shared state/network checks |
| `cloudflare/config.js` | `WORKER_URL` + cloudflared config constants |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `cloudflare/` | Cloudflare quick tunnel: `cloudflared.js` (binary ensure/kill/spawn), `manager.js` (service lifecycle: spawn, restart w/ cooldown, unexpected-exit callback, status), `healthCheck.js` (`probeUrlAlive`), `pid.js` (pidfile read/clear), `config.js` |
| `tailscale/` | Tailscale funnel: `tailscale.js` (binary detection/install, daemon + auth state, `startFunnel`/`stopFunnel`, socket const), `manager.js` (service lifecycle incl. encrypted-password provisioning via `@/mitm/manager`), `healthCheck.js`, `config.js` |
| `shared/` | Cross-service helpers: `watchdogConfig.js` (cooldown/settle/interval constants + `VIRTUAL_IFACE_REGEX`), `state.js` (`loadState`/`saveState`/`generateShortId`), `internetCheck.js` (`checkInternet`), `dnsResolver.js` |

## For AI Agents

### Working In This Directory

- Both tunnels are optional; never assume either binary is installed. `cloudflared.js`/`tailscale.js` download/install on demand.
- `manager.js` (both) keeps a single `svc` object with `cancelToken`/`spawnInProgress`/`lastRestartAt` and enforces `RESTART_COOLDOWN_MS` (120s) — respect the cooldown when touching restart logic.
- Watchdog timings and the virtual-interface regex come from `shared/watchdogConfig.js` — don't duplicate these constants in services.
- Settings live in SQLite via `@/lib/localDb` (the shim → `@/lib/db/index.js`) — both managers call `getSettings`/`updateSettings`. Keep those imports intact.
- `state.js` state file (`loadState`/`saveState`) tracks tunnel identity (`generateShortId`) — shared by both services, one field namespace.
- Health checks `probeUrlAlive` — fail-open; a tunnel that can't be probed should report status, not throw.

### Testing Requirements

- Tests live in `tests/` (independent ESM package): `cd tests && npx vitest run` from repo root.
- Tunnel tests exercise real binaries (cloudflared/tailscale) — skip unless the binaries + credentials are available; don't expect them in CI.
- Suite is NOT all-green on a plain checkout (~938 pass / ~64 fail). Judge regressions with `tests/__baseline__/verify-no-regression.mjs`.

### Common Patterns

- Public surface: add new exports to `index.js`; keep per-service logic inside `cloudflare/` or `tailscale/`.
- Lifecycle: `enable*` spawns + health-checks; watchdog monitors unexpected exit and re-spawns after cooldown.
- Shared state: `loadState`/`saveState`/`generateShortId` from `shared/state.js`.

## Dependencies

### Internal

- `@/lib/localDb` (`getSettings`/`updateSettings`) — shim → `@/lib/db/index.js`
- `@/mitm/manager` — tailscale manager `initDbHooks`/`getCachedPassword`/`loadEncryptedPassword` for password provisioning

### External

- `cloudflared` binary — cloudflare quick tunnel (downloaded on demand)
- `tailscale` binary + tailnet — funnel (downloaded/installed on demand)
- Node runtime — `node:fs`, `node:path`, `node:child_process`

<!-- MANUAL: -->
