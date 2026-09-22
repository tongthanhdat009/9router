<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-15 | Updated: 2026-09-22 -->

# config

## Purpose
Single source of routing constants: provider definitions, model/alias matrix, capabilities, runtime retries/timeouts, and format constants.

## Key Files
| File | Purpose |
|---|---|
| `providerModels.js` | Alias to provider and model matrix; add model capability metadata here |
| `runtimeConfig.js` | `HTTP_STATUS`, `RETRY_CONFIG`, `DEFAULT_RETRY_CONFIG`, timeouts and token limits |
| `providers.js` and `registry/` | Provider configuration used by registry assembly |
| `models/` (`schema.js`, `helpers.js`, `namePatterns.js`) | Model-id normalization (digit-digit hyphen to dot; `normalizeModel` consumed by `providers/index.js`) |
| `thinkingLevels.js` and `visionPatterns.js` and `catalogOverride.js` | Thinking-level tiers, vision-capability patterns, catalog overrides |
| `constants.js` and `appConstants.js` | Shared plus app-level constants |
| `models.js` and `ollamaModels.js` and `ttsModels.js` | Generic, Ollama-local, and TTS model lists |
| `errorConfig.js` | Normalized error shapes |
| `mediaConfig.js` | Image and video provider media knobs |
| `grokCli.js` and `kiroConstants.js` | Provider-specific constants |
| `codexInstructions.js` and `defaultThinkingSignature.js` | Codex system instructions; default thinking signature |
| `googleTtsLanguages.js` | Google TTS language and voice table |

## For AI Agents
### Working In This Directory
- Config-driven only: never hardcode provider, model, role, retry, or endpoint strings in callers.
- Add provider models to `providerModels.js`; provider-specific behavior belongs in the registry definition, not a scattered special case.
- Retry changes affect `BaseExecutor.execute` globally; preserve per-status semantics and provider overrides.

### Testing Requirements
- Run `tests/__baseline__/verify-*.mjs` after provider/alias changes; matrix tests derive coverage from `PROVIDER_MODELS`.

### Common Patterns
- Export immutable constants and helpers; consumers import from here rather than duplicating values.

## Dependencies
### Internal
- Used by all `open-sse/` layers.
### External
- None
