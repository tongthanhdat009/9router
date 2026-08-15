<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-15 | Updated: 2026-08-15 -->

# translator

## Purpose
Provider-format conversion layer. Translates client requests/responses between formats, pivoting through **OpenAI as the intermediate format** unless an exact `source:target` direct route exists.

## Key Files
| File | Purpose |
|---|---|
| `index.js` | Registry + `translateRequest`/`translateResponse` entry points; `register(from, to, reqFn, resFn)` |
| `formats.js` | `FORMATS` enum + `detectFormatByEndpoint(pathname, body)` (endpoint-based format detection) |
| `registerAll.js` | Imports every translator for tests (see `tests/translator/registerAll.js`) |

## Subdirectories
| Directory | Contents |
|---|---|
| `request/` | `<from>-to-<to>.js` request translators (call `register(...)`) |
| `response/` | `<from>-to-<to>.js` response translators (call `register(...)`) |
| `schema/` | Format enums/constants: ROLE, CLAUDE_BLOCK, message shapes |
| `formats/` | Per-format normalization: `openai.js`, `claude.js` (prepareClaudeRequest), `kiro.js` |
| `concerns/` | Cross-translator shared logic: `toolCall.js` (ensureToolCallIds, fixMissingToolResponses), `thinkingUnified.js` (captureThinking/applyThinking) |

## For AI Agents
### Working In This Directory
- Translators **self-register** via `register(from, to, reqFn, resFn)` as an import side-effect — a new file MUST be imported in `index.js`/`registerAll.js` or it never runs.
- Direct route (`claude:kiro`) skips the lossy OpenAI double-hop — prefer it for fragile pairs (thinking, non-base64 images, tool ids, `is_error`).
- Reuse `schema/` + `concerns/` — never re-implement parsing/thinking/tool-id logic per translator.
- Never hardcode role/block/model strings — use `schema/` and `open-sse/config/` constants.
- Kiro keeps stricter source-aware reconciliation: `fixMissingToolResponses` is skipped for Kiro targets, and Kiro thinking is mapped by the translator (KAS-compatible `systemPrompt`/`additionalModelRequestFields`), not the generic `applyThinking`.
- Endpoint-based format detection lives in `formats.js` — extend it before adding a new endpoint-specific format.

### Testing Requirements
- Tests under `tests/translator/`; `tests/translator/registerAll.js` must be imported by any test calling `translateRequest`/`translateResponse` (silent no-op = false pass).
- Direct-route behavior is covered by data-driven `tests/translator/*.test.js` — add a pair to the matrix, not a bespoke test.

### Common Patterns
- One file per `<from>-to-<to>` pair in `request/` or `response/`, named `<from>-to-<to>.js`, calling `register()` at module scope.
- Non-standard formats (kiro EventStream, cursor protobuf, commandcode NDJSON) do NOT round-trip through OpenAI — handled in their executor, not here.

## Dependencies
### Internal
- `open-sse/config/` (constants), `open-sse/executors/` (AntigravityExecutor import), `open-sse/providers/` (PROVIDERS quirks)
### External
- None
