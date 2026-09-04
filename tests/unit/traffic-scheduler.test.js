import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  beforePrepare,
  beforeUpload,
  resetSchedulerForTests,
  UPLOAD_PACING_THRESHOLD,
  UPLOAD_PACING_SPACING_MS,
  PREPARE_HEAVY_THRESHOLD,
} from "../../open-sse/scheduling/trafficScheduler.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); // keep setImmediate real
  resetSchedulerForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const HEAVY = UPLOAD_PACING_THRESHOLD + 1;
const LIGHT = UPLOAD_PACING_THRESHOLD - 1;

// 1. Interactive fast path: light request resolves with zero intentional wait and no timer.
it("light request takes no delay and allocates no timer", async () => {
  const t = vi.spyOn(globalThis, "setTimeout");
  await beforeUpload({ actualBytes: LIGHT });
  expect(t).not.toHaveBeenCalled();
  t.mockRestore();
});

// 2. Idle heavy request admits immediately without wait.
it("idle heavy request admits without wait", async () => {
  let resolved = false;
  const p = beforeUpload({ actualBytes: HEAVY });
  p.then(() => (resolved = true));
  await vi.advanceTimersByTimeAsync(0);
  expect(resolved).toBe(true);
});

// 3. Consecutive heavy requests advance the timeline deterministically by the spacing.
it("consecutive heavy requests space deterministically", async () => {
  let now = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => now);

  const resolved = [];
  const p1 = beforeUpload({ actualBytes: HEAVY }).then(() => resolved.push("a"));
  const p2 = beforeUpload({ actualBytes: HEAVY }).then(() => resolved.push("b"));
  const p3 = beforeUpload({ actualBytes: HEAVY }).then(() => resolved.push("c"));

  // Immediately: p1 scheduled at t=1000 (now) resolves; p2 at 1015, p3 at 1030
  await vi.advanceTimersByTimeAsync(0);
  expect(resolved).toEqual(["a"]);

  // Advance to t=1015: p2 resolves
  now = 1015;
  await vi.advanceTimersByTimeAsync(UPLOAD_PACING_SPACING_MS);
  expect(resolved).toEqual(["a", "b"]);

  // Advance to t=1030: p3 resolves
  now = 1030;
  await vi.advanceTimersByTimeAsync(UPLOAD_PACING_SPACING_MS);
  expect(resolved).toEqual(["a", "b", "c"]);

  await Promise.all([p1, p2, p3]);
});

// 4. Aborted signal rejects immediately without transport dispatch; timer is cleared.
it("abort during admission rejects immediately", async () => {
  const ac = new AbortController();
  const p1 = beforeUpload({ actualBytes: HEAVY }); // slot at t=now, admitted immediately
  const p2 = beforeUpload({ actualBytes: HEAVY, signal: ac.signal }); // slot in future
  await vi.advanceTimersByTimeAsync(0);
  ac.abort(new Error("client gone"));
  await expect(p2).rejects.toThrow("client gone");
  await p1;
  expect(vi.getTimerCount()).toBe(0); // no leaked timer
});

// 5. Timeline hole: aborted waiter leaves its reserved gap; subsequent request keeps its slot.
it("timeline hole after abort preserves subsequent slots", async () => {
  let now = 2000;
  vi.spyOn(performance, "now").mockImplementation(() => now);

  const ac = new AbortController();
  const p1 = beforeUpload({ actualBytes: HEAVY }); // slot at 2000
  const p2 = beforeUpload({ actualBytes: HEAVY, signal: ac.signal }); // slot at 2015
  const p3 = beforeUpload({ actualBytes: HEAVY }); // slot at 2030

  await vi.advanceTimersByTimeAsync(0);
  ac.abort(new Error("gone"));
  await expect(p2).rejects.toThrow("gone");

  // At t=2015: p3 must NOT have resolved yet (its slot is 2030, hole left behind)
  now = 2015;
  let p3Resolved = false;
  p3.then(() => (p3Resolved = true));
  await vi.advanceTimersByTimeAsync(UPLOAD_PACING_SPACING_MS);
  expect(p3Resolved).toBe(false);

  // At t=2030: p3 resolves
  now = 2030;
  await vi.advanceTimersByTimeAsync(UPLOAD_PACING_SPACING_MS);
  expect(p3Resolved).toBe(true);
  await p3;
});

// 6. beforePrepare yields only for heavy estimated sizes.
it("beforePrepare yields only above PREPARE_HEAVY_THRESHOLD", async () => {
  let yielded = false;
  const p = beforePrepare({ estimatedSize: PREPARE_HEAVY_THRESHOLD });
  p.then(() => (yielded = true));
  await Promise.resolve(); // microtask drain does NOT resolve a setImmediate promise
  expect(yielded).toBe(false);
  await new Promise((r) => setImmediate(r));
  await p;
  expect(yielded).toBe(true);

  // Light: resolves synchronously without awaiting setImmediate
  let lightDone = false;
  const pl = beforePrepare({ estimatedSize: PREPARE_HEAVY_THRESHOLD - 1 });
  pl.then(() => (lightDone = true));
  await Promise.resolve();
  expect(lightDone).toBe(true);
});

// 7. Zero per-request state after admission: no pending timers or references retained.
it("no pending timers or held state after admission", async () => {
  const ps = Array.from({ length: 5 }, () => beforeUpload({ actualBytes: HEAVY }));
  await vi.runAllTimersAsync();
  await Promise.all(ps);
  expect(vi.getTimerCount()).toBe(0);
  // Fast path still active
  await beforeUpload({ actualBytes: LIGHT });
});
