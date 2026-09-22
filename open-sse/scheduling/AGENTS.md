<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-22 | Updated: 2026-09-22 -->

# scheduling

## Purpose
Request-level traffic pacing for the upstream transport path. Spaces heavy request uploads on a global admission timeline so concurrent multi-megabyte writes do not starve small latency-sensitive requests on the same event loop.

## Key Files
| File | Purpose |
|---|---|
| `trafficScheduler.js` | `beforePrepare` (cooperative yield before heavy serialization) plus `beforeUpload` (global 15ms admission pacing at or above 256KB); env knobs `TRAFFIC_PACER`, `TRAFFIC_PACING_SPACING_MS`, `TRAFFIC_PACING_THRESHOLD`; `spacingFor`, `resetSchedulerForTests`, `UPLOAD_PACING_THRESHOLD`, `UPLOAD_PACING_SPACING_MS` |

## For AI Agents
### Working In This Directory
- Sole consumer is `executors/base.js`: `prepareRequestFair` calls `beforePrepare` with the estimated serialized size; `execute` calls `beforeUpload` with the actual UTF-8 byte length before dispatch.
- Fast path is zero-cost: requests below the threshold take no delay, no timer, no backlog; the scheduler keeps only global `nextAdmissionAt`, never streams, sockets, or inference state.
- Both hooks are abort-aware and **fail-open**: any internal error warns and proceeds to transport — never drop live traffic or throw out of a non-abort path.
- Uses the monotonic clock (`performance.now`) only; wall-clock jumps would corrupt millisecond-scale spacing.
- Benchmark-only instrumentation is env-gated (`TRAFFIC_STATS_FILE`, `BENCH_LAG_FILE`) and inert in production; `TRAFFIC_PACER=off` disables pacing (`Infinity` threshold).
- `TRAFFIC_PACER=bytes:<msPerMiB>:<minMs>:<maxMs>` selects byte-weighted spacing for A/B runs; absent, fixed 15ms spacing applies.

### Testing Requirements
- `resetSchedulerForTests` exists for test isolation — call it between admissions assertions so the global timeline does not leak across cases.
- Validate the fail-open path (scheduler error still dispatches) and the abort path (aborted signal rejects before transport).

### Common Patterns
- Call `beforePrepare` before synchronous serialization of a heavy body; call `beforeUpload` immediately before the fetch dispatch with actual bytes.

## Dependencies
### Internal
- Consumed only by `open-sse/executors/base.js`.
### External
- Node `performance.now`, `setImmediate`, `setTimeout`; optional `node:fs` append for benchmark stats.
