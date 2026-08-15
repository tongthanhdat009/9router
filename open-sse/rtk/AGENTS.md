<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-15 | Updated: 2026-08-15 -->

# rtk

## Purpose
Request token-killer pre-translate hooks: compact tool-result content and optionally proxy headroom compression.

## Key Files
| File | Purpose |
|---|---|
| `index.js` | Detects supported request shapes and mutates eligible tool results in place |
| `filters/` | Per-tool compressors + autodetection |
| `headroom.js` | External compression proxy hook |
| `caveman.js` | System-prompt injector |

## For AI Agents
### Working In This Directory
- Every hook is **fail-open**: catch errors, return `null`, leave body untouched; never throw from the request path.
- Preserve errors: skip `is_error` / `status: "error"` tool results and never emit empty content.
- Compression mutates the body in place; avoid copying or changing unrelated request fields.

### Testing Requirements
- Run RTK unit tests; verify disabled mode returns `null` and every error/below-threshold guard remains covered.

### Common Patterns
- Add a focused filter under `filters/`, let autodetection choose it, retain the existing minimum-size guard.

## Dependencies
### Internal
- `open-sse/translator/` request shapes, config/runtime flags
### External
- Optional headroom proxy
