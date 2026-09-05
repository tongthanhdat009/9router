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
// Env knobs exist for benchmark A/B of pacing policies on the production path (perf follow-up):
// TRAFFIC_PACER=off disables admission pacing; TRAFFIC_PACING_SPACING_MS / TRAFFIC_PACING_THRESHOLD
// override the constants. Absent env -> production defaults.
const envNum = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};
export const UPLOAD_PACING_THRESHOLD = process.env.TRAFFIC_PACER === "off" ? Infinity : envNum("TRAFFIC_PACING_THRESHOLD", 256 * 1024);
// Fixed spacing each admitted heavy upload advances the timeline by (ms). Winner of the policy
// comparison (0/5/10/15ms fixed, byte-weighted, 128/256/512KB thresholds).
export const UPLOAD_PACING_SPACING_MS = envNum("TRAFFIC_PACING_SPACING_MS", 15);
// Benchmark-only byte-weighted mode: TRAFFIC_PACER=bytes:<msPerMiB>:<minMs>:<maxMs> ->
// spacing(bytes) = clamp(msPerMiB * bytes/1MiB, minMs, maxMs). Absent -> fixed spacing.
const BYTE_MODE = (process.env.TRAFFIC_PACER || "").startsWith("bytes:")
  ? (process.env.TRAFFIC_PACER.split(":").slice(1).map(Number))
  : null;
export function spacingFor(actualBytes) {
  if (!BYTE_MODE) return UPLOAD_PACING_SPACING_MS;
  const per = Number.isFinite(BYTE_MODE[0]) ? BYTE_MODE[0] : 8;
  const min = Number.isFinite(BYTE_MODE[1]) ? BYTE_MODE[1] : 5;
  const max = Number.isFinite(BYTE_MODE[2]) ? BYTE_MODE[2] : 15;
  return Math.max(min, Math.min(max, (per * actualBytes) / 1048576));
}

// ---- benchmark instrumentation (env-gated; inert in production) ----
// TRAFFIC_STATS_FILE: JSONL per admission {t, actualBytes, waitMs, spacing}.
// BENCH_LAG_FILE: runtime event-loop lag + memory sampler, JSON rewritten every 2s.
import fs from "node:fs";
const STATS_PATH = process.env.TRAFFIC_STATS_FILE || "";
const LAG_PATH = process.env.BENCH_LAG_FILE || "";
function recordAdmission(evt) {
  if (!STATS_PATH) return;
  try { fs.appendFileSync(STATS_PATH, JSON.stringify(evt) + "\n"); } catch {}
}
let lagState = null;
function ensureLagSampler() {
  if (!LAG_PATH || lagState) return;
  lagState = { startedAt: Date.now(), samples: [], winStart: 0, win: [], writes: 0,
    memPeak: { rss: 0, heapUsed: 0, heapTotal: 0, external: 0 }, memLast: null };
  const s = lagState;
  // STEP must exceed the runtime's nested-timer clamp (Bun ~4ms) or clamp drift accumulates
  // into fake lag; resync after genuine >1s stalls so one stall does not poison the series.
  const STEP = 5;
  let nextAt = performance.now();
  s.winStart = nextAt;
  const fire = () => {
    const now = performance.now();
    const lag = now - nextAt;
    s.samples.push(lag); s.win.push(lag);
    if (s.samples.length > 200000) s.samples.splice(0, s.samples.length - 200000);
    if (now - s.winStart >= 5000) { s.win = s.win.slice(-2500); s.winStart = now; }
    try {
      const m = process.memoryUsage();
      s.memPeak.rss = Math.max(s.memPeak.rss, m.rss);
      s.memPeak.heapUsed = Math.max(s.memPeak.heapUsed, m.heapUsed);
      s.memPeak.heapTotal = Math.max(s.memPeak.heapTotal, m.heapTotal);
      s.memPeak.external = Math.max(s.memPeak.external, m.external);
      s.memLast = m;
    } catch {}
    nextAt += STEP;
    if (nextAt < now - 1000) nextAt = now;
    setTimeout(fire, Math.max(0, nextAt - performance.now()));
  };
  setTimeout(fire, STEP);
  const q = (arr, p) => { if (!arr.length) return null; const a = arr.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.max(0, Math.round((p / 100) * (a.length - 1))))]; };
  setInterval(() => {
    if (!lagState) return;
    try {
      fs.writeFileSync(LAG_PATH, JSON.stringify({ startedAt: s.startedAt, writes: ++s.writes, n: s.samples.length,
        lagMs: { p50: q(s.samples, 50), p95: q(s.samples, 95), p99: q(s.samples, 99), max: s.samples.length ? Math.max(...s.samples) : null },
        lag5s: { n: s.win.length, p95: q(s.win, 95), p99: q(s.win, 99) },
        memPeak: s.memPeak, memLast: s.memLast }));
    } catch {}
  }, 2000);
  setInterval(() => {}, 10000); // keep the event loop alive for post-load settle sampling
}
// Pre-serialization character estimate above which we cooperative-yield before JSON.stringify.
export const PREPARE_HEAVY_THRESHOLD = process.env.TRAFFIC_PREPARE_YIELD === "off" ? Infinity : envNum("TRAFFIC_PREPARE_THRESHOLD", 262144);

let nextAdmissionAt = 0;

export function resetSchedulerForTests() {
  nextAdmissionAt = 0;
}

// Cooperative yield before synchronous serialization of a heavy body. Keeps the event loop's check
// phase available to small requests while several multi-MB JSON.stringify blocks queue up.
export async function beforePrepare({ estimatedSize = 0, signal = null } = {}) {
  if (LAG_PATH) ensureLagSampler();
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
    const spacing = spacingFor(actualBytes);
    nextAdmissionAt = scheduledAt + spacing;
    recordAdmission({ t: Math.round(now), actualBytes, waitMs: Math.max(0, scheduledAt - now), spacing });

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
