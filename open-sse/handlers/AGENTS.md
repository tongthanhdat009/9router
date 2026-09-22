<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-15 | Updated: 2026-09-22 -->

# handlers

## Purpose
Modality cores: chat, responses/decisions, image, embeddings, TTS, STT, video, search, fetch. Handlers select formats/executors and shape streaming or JSON output.

## Key Files
| File | Purpose |
|---|---|
| `chatCore.js` | Main provider-agnostic chat flow |
| `chatCore/` | Streaming, non-streaming, and SSE-to-JSON terminal paths (`streamingHandler.js`, `nonStreamingHandler.js`, `sseToJsonHandler.js`, `requestDetail.js`) |
| `responsesHandler.js` / `decisionsCore.js` | Codex Responses API flow; OpenRouter SystemOne/alpha-decisions transparent JSON pass-through (no translation) |
| `imageGenerationCore.js` / `imageProviders/` | Image generation core + per-provider backends |
| `embeddingsCore.js` / `embeddingProviders/` | Embeddings core + per-provider backends |
| `ttsCore.js` / `ttsProviders/` | TTS core + per-provider backends |
| `sttCore.js` | Speech-to-text core |
| `videoCore.js` / `videoProviders/` | Video generation core + per-provider backends |
| `search/` | Chat search, callers, normalizers (`chatSearch.js`, `callers.js`, `normalizers.js`) |
| `fetch/` | Web Fetch handler (firecrawl, jina-reader, tavily, exa, ollama) with normalized return shape |

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
