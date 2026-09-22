<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-15 | Updated: 2026-09-22 -->

# open-sse

Provider-agnostic SSE engine: one OpenAI-style request goes to any provider (LLM chat, image, embedding, tts, stt, search), streamed back in the client format.

## Request lifecycle (chat)

`src/sse/handlers/chat.js` `handleChat` owns affinity/JSONL plus combo/account fallback, then delegates to `handlers/chatCore.js` to `services/model.js` `parseModel` (resolve `provider/model`) to pre-translate hooks (`rtk/` tool_result compress, `rtk/headroom.js` proxy compress, `rtk/caveman.js` system inject, all fail-open) to `executors/index.js` `getExecutor(provider)` to `translator/index.js` `translateRequest` (client format to provider format) to `executor.execute()` (streams upstream) to `translateResponse` (provider chunks to client format) to SSE out. Bindings live in `src/sse/services/sessionAffinity.js` via `src/lib/affinityLogger.js` JSONL (opt-in `ENABLE_AFFINITY_LOG=1` / `enableObservability`), not SQLite metadata.

## Directory map

- `config/` — ALL constants and config (no hardcode elsewhere). `providers.js` plus `registry/` (126 provider defs), `providerModels.js` (alias to models matrix), `runtimeConfig.js` (timeouts, token limits), `models/` (schema, helpers, namePatterns id normalization), `thinkingLevels.js` and `visionPatterns.js` plus `catalogOverride.js`, `*Constants.js`.
- `translator/` — format conversion across 13 formats. `request/<from>-to-<to>.js`, `response/<from>-to-<to>.js`, `schema/` (ROLE, CLAUDE_BLOCK, finishReasons), `concerns/` (modality, prefetch, kiroConversation, paramSupport, finishReason), `formats/` (per-format). `index.js` statically imports about 22 translators; tests use `tests/translator/registerAll.js`.
- `executors/` — per-provider upstream call. `base.js` (BaseExecutor; sole `scheduling/` consumer via `beforePrepare` and `beforeUpload`), one file per special provider, `index.js` map.
- `scheduling/` — `trafficScheduler.js`: heavy-upload admission pacing (at or above 256KB spaced 15ms on a global timeline) plus pre-serialize event-loop yield. Fail-open; see `scheduling/AGENTS.md`.
- `providers/` — registry build plus `capabilities.js` plus `pricing.js` plus `thinkingLevels.js`, `visionPatterns.js`, `catalogOverride.js`. Entry: `index.js` (PROVIDERS).
- `handlers/` — per-modality cores: `chatCore.js` (plus `chatCore/`), `decisionsCore.js`, `embeddingsCore.js`, `imageGenerationCore.js`, `responsesHandler.js`, `sttCore.js`, `ttsCore.js`, `videoCore.js`, plus sub-provider folders.
- `rtk/` — request token-killer. `index.js` compresses `tool_result` in-place; `ponytail.js` and `ponytailPrompt.js`, `pxpipe.js`, `systemInject.js`, `registry.js`, `cavemanPrompts.js`, `applyFilter.js`, `constants.js`, `autodetect.js`; `headroom.js` external compress proxy; `caveman.js` system-prompt injector. All fail-open.
- `transformer/` — `responsesTransformer.js` (Chat Completions SSE to Codex Responses API SSE), `streamToJsonConverter.js`.
- `shared/` — cross-provider auth and identity: `clineAuth.js`, `clineEnvelope.js`, `machineId.js`, `zedAuth.js`, `qoder/`.
- `services/` — `model.js`, `provider.js`, `accountFallback.js`, `combo.js` (`getRotatedModels(models,comboName,strategy,stickyLimit=1,rotationScope=null)`, rotation key `combo:scope`), `thoughtSignatureStore.js`, `zcodeKey.js`, per-sub-provider `*Models.js`, `capacityAdapter.js`, `tokenRefresh/` plus `tokenRefresh.js`, `oauthCredentialManager.js`, `usage/`, `projectId.js`.
- `utils/` — streamHandler, stream (Responses `response.failed` synthesis plus passthrough sentinel rules), sse, error, sessionManager (session-id keys), `debugLog.js` (dev-only console), usageTracking, toolDeduper, zcodeIdentity, bypassHandler, claudeCloaking, clientDetector, proxyFetch, cursorProtobuf and cursorChecksum, ollamaTransform.

## Conventions

- Config-driven, DRY, camelCase. NEVER hardcode values, models, or block and role strings — use `config/` plus `schema/` constants.
- Translator pipeline pivots through OpenAI as the intermediate format. A translator registered on the exact `source:target` pair (for example `claude:kiro`) runs as a **direct route**, skipping the lossy double-hop.
- Translators self-register via `register(from, to, reqFn, resFn)` as an import side-effect — new files MUST be imported in `translator/index.js`.

## How to add

- **Provider**: copy `providers/REGISTRY_TEMPLATE.js` to `providers/registry/{id}.js`; add models to `config/providerModels.js`. Generic providers need no executor (DefaultExecutor handles OpenAI-compatible APIs).
- **Executor** (only for non-standard upstream): subclass `BaseExecutor` (override `getBaseUrls`, `buildHeaders`, `buildUrl`, `execute`), register in `executors/index.js` map. `getExecutor` falls back to `DefaultExecutor` when absent.
- **Translator**: add `request|response/<from>-to-<to>.js` calling `register(...)`, then import it in `translator/index.js`. Reuse `schema/` plus `concerns/` — do not re-implement parsing.

## Pitfalls

- OpenAI bridge is lossy (thinking, non-base64 images, tool ids, is_error) — prefer a direct route for fragile pairs.
- `registry/index.js` is an auto-generated static import list; regenerate it (do not hand-edit) after adding a `registry/{id}.js`. REGISTRY_TEMPLATE is excluded by design.
- Special binary and protobuf formats (kiro EventStream, cursor protobuf, commandcode NDJSON) do not round-trip through OpenAI — handle in their executor.
- `rtk/` plus `headroom.js` mutate the request body in-place and are **fail-open**: any error returns null and leaves the body untouched — never throw out of them. RTK skips `is_error` and `status:"error"` tool results to preserve traces.
