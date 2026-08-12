<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-12 | Updated: 2026-08-12 -->

# mitm
## Purpose
Man-in-the-middle proxy layer used for CLI-tool OAuth credential capture and antigravity traffic handling. Runs a local proxy (TLS cert generation/install, DNS config) with per-vendor request handlers for cursor/copilot/kiro/antigravity.

## Key Files
| File | Purpose |
|---|---|
| `server.js` | Proxy server lifecycle |
| `manager.js` | Proxy session/capture management |
| `config.js` | MITM config |
| `dbReader.js` | Read captured credentials from local DB |
| `paths.js` | File path resolution |
| `logger.js` | Logging |
| `winElevated.js` | Windows elevated-privilege helpers (cert install) |
| `antigravityIdeVersion.js` | Antigravity IDE version detection |

## Subdirectories
| Directory | Contents |
|---|---|
| `cert/` | Root CA generate/install |
| `dns/` | DNS config |
| `handlers/` | Per-vendor: antigravity, base, copilot, cursor, kiro |

## For AI Agents
### Working In This Directory
Security-sensitive: this intercepts tool traffic and reads credentials. Preserve the fail-open/skip behavior — never throw out of capture paths. Test cert/install changes on the target OS before claiming them working.
### Testing Requirements
No dedicated test file — validate via a live proxy capture (needs a CLI tool) or a manual smoke run. Keep changes scoped to the capture path.
### Common Patterns
Each vendor gets a handler in `handlers/` extending `base.js`; shared TLS/DNS setup lives in `cert/` and `dns/`.

## Dependencies
### Internal
`src/lib/db/`, `src/shared/`
### External
Node TLS/HTTP, platform cert tooling (OS-specific)
<!-- MANUAL: -->
