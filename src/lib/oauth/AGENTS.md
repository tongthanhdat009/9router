<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-12 | Updated: 2026-08-12 -->

# src/lib/oauth

## Purpose

Per-provider OAuth flows for 9Router — the definitions powering `src/app/api/oauth/*` (browser login, callback, token exchange) and `open-sse` token refresh. One provider file per upstream (claude, codex, cursor, gemini-cli, github, grok-cli, kiro, xai, …), plus services that orchestrate exchange/refresh and shared PKCE/IDP utilities. Provider definitions are consumed by `src/lib/oauth/services/` and the app's OAuth API routes; the resulting credentials feed `src/lib/db/repos/connectionsRepo.js`.

## Key Files

| File | Description |
|------|-------------|
| `providers.js` | Re-export of `./providers/index.js` (the 24-file registry) |
| `providers/index.js` | Registry assembly — imports `open-sse/index.js` (ensures outbound fetch respects HTTP(S)_PROXY/ALL_PROXY) then builds `PROVIDERS` map |
| `providerHelpers.js` | Shared helpers: xAI OAuth-endpoint validation (https + `x.ai` host check), xAI id-token email decode, codex account info, kiro profile ARN fetch |
| `kiroExternalIdp.js` | Kiro's external-IDP validation: Microsoft token-endpoint allow-list, region/expiry defaults |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `constants/` | `oauth.js` (shared OAuth constants), `xai.js` (xAI-specific endpoints/scopes) |
| `providers/` | 24 provider flow files: antigravity, claude, cline, clinepass, codebuddy-cn, codebuddy-intl, codex, cursor, gemini-cli, github, gitlab, grok-cli, iflow, index, kilocode, kimchi, kimi, kiro, qoder, trae, windsurf, xai, zed + `_shared.js` |
| `services/` | Orchestration services per provider: antigravity, claude, codex, cursor, gemini, github, iflow, index, kimchi, kiro, openai, qoder, xai + `oauth.js` (generic `OAuthService`) |
| `utils/` | `pkce.js` (PKCE code-verifier/challenge), `server.js` (local callback server), `ui.js` (login banner/UI), `ideDetect.js`, `banner.js` |

## For AI Agents

### Working In This Directory

- One provider = one flow file in `providers/`. Add a new provider by adding a file there and registering it in `providers/index.js`.
- `providers/index.js` imports `open-sse/index.js` at the top — preserve that side effect (outbound-proxy env support).
- Services call `db` repos (`connectionsRepo`) to persist credentials/tokens — tokens stored via `@/lib/db/index.js`.
- Security-sensitive: PKCE must be generated per flow (`utils/pkce.js`); xAI endpoints and kiro/Microsoft token endpoints are allow-listed in `providerHelpers.js`/`kiroExternalIdp.js` — never weaken the https/host validation.
- `open-sse` token refresh consumes the same provider definitions — keep flows compatible with headless refresh, not just browser callback.

### Testing Requirements

- Tests live in `tests/` (independent ESM package): `cd tests && npx vitest run` from repo root.
- `unit/xai-oauth-service.test.js` times out (5s) when the xAI endpoint-discovery fetch isn't reachable/mocked — expected red on plain checkout.
- Suite is NOT all-green on a plain checkout (~938 pass / ~64 fail). Judge regressions with `tests/__baseline__/verify-no-regression.mjs`.
- `*.real.test.js` make live provider calls — skip unless credentials are set.

### Common Patterns

- Flow file: exports provider metadata + `getAuthUrl`/`exchangeCode`/`refresh` (or equivalent) shaped for the app's `/api/oauth/*` routes.
- Reuse `_shared.js` and `utils/` pieces instead of duplicating PKCE/callback-server code per provider.
- Credential write path: provider service → `connectionsRepo` via `@/lib/db/index.js`.

## Dependencies

### Internal

- `@/lib/db/` (`connectionsRepo` via `@/lib/db/index.js`) — credential persistence
- `open-sse/index.js` — imported for outbound-proxy side effect in `providers/index.js`
- `@/lib/oauth/providers/*` ↔ `@/lib/oauth/services/*` — service layer consumes provider definitions

### External

- `open` — launch browser for login (via root package)
- Node runtime — `node:http`/`node:crypto` (PKCE, local callback server in `utils/`)
- Provider HTTP endpoints (login.microsoftonline.com, x.ai discovery, GitHub/GitLab, etc.)

<!-- MANUAL: -->
