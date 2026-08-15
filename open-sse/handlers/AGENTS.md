<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-15 | Updated: 2026-08-15 -->

# handlers

## Purpose
Modality cores: chat, image, embeddings, TTS, STT, search. Handlers select formats/executors and shape streaming or JSON output.

## Key Files
| File | Purpose |
|---|---|
| `chatCore.js` | Main provider-agnostic chat flow |
| `chatCore/` | Streaming, non-streaming, and SSE-to-JSON terminal paths |
| `image.js`, `embeddings.js`, `tts.js`, `stt.js`, `search.js` | Per-modality cores |

## For AI Agents
### Working In This Directory
- `src/sse/handlers/` is app-side glue; this directory owns provider-agnostic execution.
- Preserve all terminal paths: streaming Response, normal completion, and SSE-to-JSON conversion each must maintain equivalent usage/error semantics — and each is an `affinity.request` finalize point (only when `streamPending` cleared / usage exists), exactly-once via `diagnostics.finalized`.
- Send format translation to `translator/`; provider protocol exceptions belong in `executors/`.

### Testing Requirements
- Exercise relevant `tests/unit/` handler coverage; use baseline verification after registry/alias changes.

### Common Patterns
- Parse model → translate → execute → translate response; keep modality handlers thin around shared services.

## Dependencies
### Internal
- `open-sse/services/`, `translator/`, `executors/`, `transformer/`
### External
- Web Streams / SSE runtime APIs
