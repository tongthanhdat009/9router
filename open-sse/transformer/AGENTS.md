<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-15 | Updated: 2026-08-15 -->

# transformer

## Purpose
Stream-format transformers: convert Chat Completions SSE → Codex Responses API SSE, and Responses API SSE streams → single JSON (for non-streaming clients against streaming-only providers like Codex).

## Key Files
| File | Purpose |
|---|---|
| `responsesTransformer.js` | Chat Completions SSE → Codex Responses API SSE; `createResponsesApiTransformStream` (Node + Cloudflare Workers) |
| `streamToJsonConverter.js` | Responses SSE stream → single JSON response; `convertResponsesStreamToJson` |

## For AI Agents
### Working In This Directory
- Consumers: `open-sse/handlers/responsesHandler.js` and `open-sse/handlers/chatCore/sseToJsonHandler.js`. Send format conversion here, never in handlers.
- `responsesTransformer.js` guards `fs`/logging for worker environments (no fs) — preserve the runtime guards when editing.
- Preserve SSE event ordering/IDs and backpressure; only `streamToJsonConverter.js` intentionally buffers (its job is to collapse the stream).
- This is a one-way transform to the Responses format — it is NOT a general translator (see `translator/` for client↔provider format pairs).

### Testing Requirements
- `tests/` covers responses transformation; extend converter tests when changing event shapes.

### Common Patterns
- Pure transform functions over SSE event objects; no provider network calls.

## Dependencies
### Internal
- `open-sse/handlers/` (responsesHandler, chatCore/sseToJsonHandler)
### External
- Web Streams; `fs`/`path` (Node only, guarded)
