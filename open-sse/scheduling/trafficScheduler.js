// Generic request-level traffic scheduler (perf 2026-09-05).
// Empirical prototype (scripts/bench/prototype-pacer.mjs, real Mux fixtures, local HTTPS SSE upstreams):
// under 8 concurrent heavy projects the small-request victim went p50 82.2 / p95 222.3ms (baseline)
// -> 62.6 / 89.2ms with fixed 15ms upload spacing @256KB threshold; heavy batch wall 323.7 -> 218.9ms,
// burst-50 wall 1099.4 -> 707.5ms, throughput 60.6 -> 80.4 RPS (+33%), event-loop p95 105.9 -> 58.7ms.
// Byte-weighted spacing measured no better than fixed 15ms -> rejected for simplicity.
//
// Design invariants (see plan ~/.xum/plans/9router/runtime-cx16.md):
// - Interactive fast path: requests below UPLOAD_PACING_THRESHOLD take no delay, no timer, no backlog.
// - Monotonic clock (performance.now) only; Date.now clock jumps would corrupt ms-scale spacing.
// - Zero request state after admission: scheduler retains only global nextAdmissionAt; it never owns
//   streams, sockets, or inference. An aborted waiter leaves an unused gap in the timeline (no compaction).
// - Fail-open: any internal scheduler error must never drop live traffic.

// Serialized-UTF-8-byte threshold above which an upload reserves a slot on the admission timeline.
export const UPLOAD_PACING_THRESHOLD = 256 * 1024;
// Fixed spacing each admitted heavy upload advances the timeline by (ms). Winner of the policy
// comparison (0/5/10/15ms fixed, byte-weighted, 128/256/512KB thresholds).
export const UPLOAD_PACING_SPACING_MS = 15;
// Pre-serialization character estimate above which we cooperative-yield before JSON.stringify.
export const PREPARE_HEAVY_THRESHOLD = 262144;

let nextAdmissionAt = 0;

export function resetSchedulerForTests() {
  nextAdmissionAt = 0;
}

// Cooperative yield before synchronous serialization of a heavy body. Keeps the event loop's check
// phase available to small requests while several multi-MB JSON.stringify blocks queue up.
export async function beforePrepare({ estimatedSize = 0, signal = null } = {}) {
  if (estimatedSize < PREPARE_HEAVY_THRESHOLD) return;
  if (signal?.aborted) throw signal.reason || new Error("Aborted");
  await new Promise((resolve) => setImmediate(resolve));
}

function sleep(waitMs, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, waitMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new Error("Aborted"));
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

// Upload-start admission on a global forward-looking timeline. Heavy uploads (>= threshold serialized
// bytes) are spaced UPLOAD_PACING_SPACING_MS apart so concurrent multi-MB TLS/socket writes do not
// pile onto the event loop in the same instant, which is what starves small interactive requests.
export async function beforeUpload({ actualBytes = 0, signal = null } = {}) {
  if (actualBytes < UPLOAD_PACING_THRESHOLD) return;
  if (signal?.aborted) throw signal.reason || new Error("Aborted");

  try {
    const now = performance.now();
    // Self-sanitizing: recover a corrupted timeline instead of poisoning all future admissions.
    if (!Number.isFinite(nextAdmissionAt)) {
      nextAdmissionAt = now;
    }

    const scheduledAt = Math.max(now, nextAdmissionAt);
    nextAdmissionAt = scheduledAt + UPLOAD_PACING_SPACING_MS;

    const waitMs = scheduledAt - now;
    if (waitMs > 0) {
      await sleep(waitMs, signal);
    }
  } catch (error) {
    // Client cancellation propagates immediately; no transport dispatch should follow.
    if (signal?.aborted || error?.name === "AbortError") throw error;
    // Unexpected scheduler bug: fail open to the transport path, never drop live traffic.
    console.warn("[TrafficScheduler] beforeUpload failed open:", error);
    if (!Number.isFinite(nextAdmissionAt)) nextAdmissionAt = performance.now();
  }
}
