<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-15 | Updated: 2026-09-22 -->

# rtk

## Purpose
Request token-killer pre-translate hooks: compact tool-result content (filters), inject system-prompt token savers (caveman/ponytail), render context as PNGs (pxpipe), and optionally proxy headroom compression.

## Key Files
| File | Purpose |
|---|---|
| `index.js` | Detects supported request shapes and mutates eligible tool results in place |
| `filters/` | 12 per-tool compressors: gitDiff, gitStatus, gitLog, grep, find, ls, tree, readNumbered, searchList, dedupLog, buildOutput, smartTruncate |
| `autodetect.js` | Ported auto-detection chain ending in smart-truncate, else null |
| `applyFilter.js` | Ported `safeApply` — on panic/error pass raw output through |
| `registry.js` / `constants.js` | Filter registry and thresholds/detection-window constants |
| `caveman.js` + `cavemanPrompts.js` | Caveman-style system-prompt injector with intensity-level prompts |
| `ponytail.js` + `ponytailPrompt.js` | Lazy-senior-dev system-prompt injector with intensity-level prompts |
| `systemInject.js` | Shared `injectSystemPrompt` used by both injectors; dispatches by request format so translated and native-passthrough flows both work |
| `pxpipe.js` | Renders bulky Claude-format context as dense PNGs via pxpipe-proxy library API; fail-open |
| `headroom.js` | External compression proxy hook |

## For AI Agents
### Working In This Directory
- Every hook is **fail-open**: catch errors, return `null`, leave body untouched; never throw from the request path.
- Preserve errors: skip error tool results and never emit empty content.
- Compression mutates the body in place; avoid copying or changing unrelated request fields.
- Injectors append to the system message just before dispatch — keep them format-aware via `systemInject.js`.

### Testing Requirements
- Run RTK unit tests; verify disabled mode returns `null` and every error/below-threshold guard remains covered.

### Common Patterns
- Add a focused filter under `filters/`, let `autodetect.js` choose it, retain the existing minimum-size guard.

## Dependencies
### Internal
- `open-sse/translator/` request shapes, config/runtime flags
### External
- Optional headroom proxy; pxpipe-proxy (PNG rendering)
