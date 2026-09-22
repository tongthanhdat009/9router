<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-15 | Updated: 2026-09-22 -->

# shared

## Purpose
Cross-provider auth/identity helpers: provider-specific token builders, machine identity, Cline envelope unwrapping, and vendored protocol clients (Qoder COSY signing, Zed native-app auth).

## Key Files
| File | Purpose |
|---|---|
| `clineAuth.js` | Cline access-token header builder (`buildClineHeaders`) |
| `clineEnvelope.js` | Unwraps the Cline non-stream envelope for providers opting in via `transport.quirks.clineEnvelope` |
| `machineId.js` | Consistent machine ID (`getConsistentMachineId`) for headers/fingerprints |
| `zedAuth.js` | Zed native-app auth: ephemeral RSA keypair browser flow, RSA-encrypted access token callback |
| `qoder/` | Qoder API client: `constants.js`, `cosy.js` (RSA signing), `encoding.js` |

## For AI Agents
### Working In This Directory
- **This dir is canonical.** `src/shared/utils/clineAuth.js` and `src/lib/qoder/*` are re-export shims → edit HERE, never in `src/` copies. `src/lib/oauth/providers/zed.js` CONSUMES `zedAuth.js` (wires the flow into OAuth config) — keep its imports/signatures in sync.
- Auth/identity changes affect every consumer: `open-sse/executors/`, `open-sse/services/` (clinepassModels, qoderModels), `src/lib/oauth/providers/zed.js`. Keep signatures backward-compatible or update all callers in one change.
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
- `node-machine-id`, Node crypto (RSA signing)
