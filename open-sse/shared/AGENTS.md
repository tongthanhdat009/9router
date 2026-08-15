<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-15 | Updated: 2026-08-15 -->

# shared

## Purpose
Cross-provider auth/identity helpers: provider-specific token builders, machine identity, and vendored protocol clients (Qoder COSY signing, Zed native-app auth).

## Key Files
| File | Purpose |
|---|---|
| `clineAuth.js` | Cline access-token header builder (`buildClineHeaders`) |
| `machineId.js` | Consistent machine ID (`getConsistentMachineId`) for headers/fingerprints |
| `zedAuth.js` | Zed native-app auth: ephemeral RSA keypair → `zed.dev/native_app_signin` browser flow, RSA-encrypted access token callback |
| `qoder/` | Qoder API client: `constants.js` (endpoints), `cosy.js` (RSA+AES+MD5 signing), `encoding.js` (body encode) |

## For AI Agents
### Working In This Directory
- **This dir is canonical.** `src/shared/utils/clineAuth.js` and `src/lib/qoder/*` are re-export shims → edit HERE, never in `src/` copies. `src/lib/oauth/providers/zed.js` CONSUMES `zedAuth.js` (wires the flow into OAuth config) — keep its imports/signatures in sync.
- Auth/identity changes affect every consumer: `open-sse/executors/` (default, grok-cli, qoder, zed), `open-sse/services/` (clinepassModels, qoderModels), `src/lib/oauth/providers/zed.js`. Keep signatures backward-compatible or update all callers in one change.
- `machineId.js` imports `node-machine-id` (Node-only) — keep worker/runtime guards if file is imported in edge contexts.
- Never log tokens, RSA keys, or signing material.

### Testing Requirements
- `tests/` covers provider auth via executor/translator suites; run `tests/__baseline__/verify-*.mjs` after touching qoder/zed/cline auth.

### Common Patterns
- Pure functions of (token, state) → headers/body; no provider-config imports — consumers wire provider-specific config.

## Dependencies
### Internal
- `open-sse/executors/` (default, grok-cli, qoder, zed), `open-sse/services/` (clinepassModels, qoderModels)
### External
- `node-machine-id`, Node crypto (RSA/AES/MD5)
