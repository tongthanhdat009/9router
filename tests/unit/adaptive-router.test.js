import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAdaptiveRouter } from "../../open-sse/services/adaptiveRouter.js";
import * as config from "../../open-sse/config/adaptive.js";

function makeRouter(t0 = 0) {
  let t = t0;
  const router = createAdaptiveRouter({ now: () => t });
  return { router, tick: (ms) => { t += ms; }, time: () => t };
}

function ok(overrides = {}) {
  return { layer: "account", providerId: "p", modelId: "m", connectionId: "a", outcome: "success", completionTokens: 200, semanticTtftMs: 500, streamSpanMs: 5000, ...overrides };
}

describe("adaptive router", () => {
  let env;
  beforeEach(() => { env = makeRouter(); });
  afterEach(() => { env.router.reset(); });

  it("config exports all frozen constants", () => {
    expect(config).toMatchObject({ latencyScaleMs: 2000, weightRatioCap: 8, cooldownMs: 60000, maxConcurrentProbesPerKey: 1, staleTtlMs: 600000, maxKeys: 2000, ewmaAlpha: 0.3, slowStreakThreshold: 2, recoveryTpsMargin: 18, minSampleTokens: 64, minSpanMs: 1000 });
  });

  it("cold start: unknown candidates are ordered fairly and pick neutral", () => {
    const { router } = env;
    const r1 = router.selectAccount({ providerId: "p", modelId: "m", candidates: ["a", "b"] });
    expect(r1.ordered).toEqual(["a", "b"]);
    expect(r1.probe).toBeNull();
  });

  it("fairness at equal weights", () => {
    const { router } = env;
    const pick = () => router.selectAccount({ providerId: "p", modelId: "m", candidates: ["a", "b"] }).ordered[0];
    router.recordObservation(ok({ connectionId: "a" }));
    router.recordObservation(ok({ connectionId: "b" }));
    const picks = [pick(), pick(), pick(), pick()];
    expect(picks.filter((x) => x === "a").length).toBe(2);
    expect(picks.filter((x) => x === "b").length).toBe(2);
  });

  it("bounded split: faster candidate wins majority without starving the slow one", () => {
    const { router } = env;
    router.recordObservation(ok({ connectionId: "fast", completionTokens: 1600 }));
    router.recordObservation(ok({ connectionId: "slow", completionTokens: 200 }));
    const picks = [];
    for (let i = 0; i < 90; i++) {
      picks.push(router.selectAccount({ providerId: "p", modelId: "m", candidates: ["fast", "slow"] }).ordered[0]);
    }
    const fast = picks.filter((x) => x === "fast").length;
    const slow = picks.filter((x) => x === "slow").length;
    expect(fast).toBeGreaterThan(slow);
    expect(slow).toBeGreaterThanOrEqual(5);
    expect(fast + slow).toBe(90);
  });

  it("selectRoute orders route objects by learned speed", () => {
    const { router } = env;
    router.recordObservation(ok({ modelId: "m1", connectionId: "a", completionTokens: 1600 }));
    router.recordObservation(ok({ modelId: "m2", connectionId: "a", completionTokens: 200 }));
    const r = router.selectRoute({ providerId: "p", modelId: "m", candidates: [{ providerId: "p", modelId: "m1" }, { providerId: "p", modelId: "m2" }] });
    expect(r.ordered[0]).toEqual({ providerId: "p", modelId: "m1" });
    expect(r.probe).toBeNull();
    const lease = router.reserve({ layer: "route", providerId: "p", modelId: "m1" });
    expect(lease).toBeTruthy();
    expect(router.release(lease)).toBe(true);
  });

  it("outlier stability: one fast sample then slow stream stays sampled, not blackholed", () => {
    const { router } = env;
    router.recordObservation(ok({ completionTokens: 5000, streamSpanMs: 1000 }));
    router.recordObservation(ok({ completionTokens: 64, streamSpanMs: 60000 }));
    const r = router.selectAccount({ providerId: "p", modelId: "m", candidates: ["a"] });
    expect(r.ordered).toEqual(["a"]);
  });

  it("rejected dispositions: missing, zero, negative, NaN, estimated, tiny, cancelled", () => {
    const { router } = env;
    expect(router.recordObservation(ok({ estimated: true }))).toMatchObject({ accepted: false, reason: "estimated_usage" });
    expect(router.recordObservation(ok({ completionTokens: 10 }))).toMatchObject({ accepted: false, reason: "insufficient_tokens" });
    expect(router.recordObservation(ok({ completionTokens: 0 }))).toMatchObject({ accepted: false, reason: "insufficient_tokens" });
    expect(router.recordObservation(ok({ completionTokens: NaN }))).toMatchObject({ accepted: false, reason: "insufficient_tokens" });
    expect(router.recordObservation(ok({ streamSpanMs: 0 }))).toMatchObject({ accepted: false, reason: "invalid_timing" });
    expect(router.recordObservation(ok({ streamSpanMs: -5 }))).toMatchObject({ accepted: false, reason: "invalid_timing" });
    expect(router.recordObservation(ok({ outcome: "cancelled" }))).toMatchObject({ accepted: false, reason: "cancelled" });
    expect(router.recordObservation(ok({ outcome: "error" }))).toMatchObject({ accepted: false, reason: "not_success" });
    expect(router.recordObservation(ok({ connectionId: "" }))).toMatchObject({ accepted: false, reason: "invalid_key" });
    expect(router.recordObservation(ok({ providerId: "" }))).toMatchObject({ accepted: false, reason: "invalid_key" });
    expect(router.recordObservation(ok({ semanticTtftMs: NaN }))).toMatchObject({ accepted: false, reason: "invalid_timing" });
  });

  it("span floor: 1s minimum span guards burst inflation", () => {
    const { router } = env;
    const r = router.recordObservation(ok({ completionTokens: 300, streamSpanMs: 5 }));
    expect(r.accepted).toBe(true);
    expect(r.tps).toBeCloseTo(300);
  });

  it("route aggregation: fast+slow accounts under same provider/model both update route once per sample", () => {
    const { router } = env;
    router.recordObservation(ok({ connectionId: "a" }));
    router.recordObservation(ok({ connectionId: "b", completionTokens: 240 }));
    const snap = router.snapshot();
    const route = snap.entries.find((e) => e.key[0] === "route" && e.key[2] === "m");
    expect(route).toBeTruthy();
    expect(route.samples).toBe(2);
  });

  it("per-model separation: same provider different models stay distinct", () => {
    const { router } = env;
    router.recordObservation(ok({ modelId: "m1" }));
    router.recordObservation(ok({ modelId: "m2" }));
    const models = router.snapshot().entries.filter((e) => e.key[0] === "route").map((e) => e.key[2]).sort();
    expect(models).toEqual(["m1", "m2"]);
  });

  it("cooldown after two consecutive slow samples", () => {
    const { router } = env;
    router.recordObservation(ok({ completionTokens: 64, streamSpanMs: 60000 }));
    const second = router.recordObservation(ok({ completionTokens: 64, streamSpanMs: 60000 }));
    expect(second.accepted).toBe(true);
    const r = router.selectAccount({ providerId: "p", modelId: "m", candidates: ["a", "b"] });
    expect(r.ordered).toEqual(["b", "a"]);
    expect(r.probe).toBe("a");
    expect(r.reasons).toEqual({ a: "cooldown" });
  });

  it("single probe: one cooled candidate admitted exactly once", () => {
    const { router } = env;
    router.recordObservation(ok({ connectionId: "a", completionTokens: 64, streamSpanMs: 60000 }));
    router.recordObservation(ok({ connectionId: "a", completionTokens: 64, streamSpanMs: 60000 }));
    const r = router.selectAccount({ providerId: "p", modelId: "m", candidates: ["a", "b"] });
    expect(r.ordered).toEqual(["b", "a"]);
    expect(r.probe).toBe("a");
    const first = router.reserve({ layer: "account", providerId: "p", modelId: "m", connectionId: "a", probe: true });
    expect(first).toBeTruthy();
    expect(router.reserve({ layer: "account", providerId: "p", modelId: "m", connectionId: "a", probe: true })).toBeNull();
    expect(router.selectAccount({ providerId: "p", modelId: "m", candidates: ["a", "b"], allowProbe: false }).probe).toBeNull();
  });

  it("recovery ramp: probe >= 18 TPS restores with ramp, then full", () => {
    const { router } = env;
    for (let i = 0; i < 2; i++) router.recordObservation(ok({ completionTokens: 64, streamSpanMs: 60000 }));
    const sel = router.selectAccount({ providerId: "p", modelId: "m", candidates: ["a"] });
    expect(sel.probe).toBe("a");
    const lease = router.reserve({ layer: "account", providerId: "p", modelId: "m", connectionId: "a", probe: true });
    expect(lease).toBeTruthy();
    const mr = router.markProbeResult(lease, ok({ completionTokens: 360, streamSpanMs: 10000 }));
    expect(mr.accepted).toBe(true);
    expect(mr.tps).toBe(36);
    const snap = router.snapshot().entries.find((e) => e.key[3] === "a");
    expect(snap.cooledUntil).toBe(0);
    expect(snap.score).toBeLessThan(36);
    router.recordObservation(ok({ completionTokens: 360, streamSpanMs: 10000 }));
    const snap2 = router.snapshot().entries.find((e) => e.key[3] === "a");
    expect(snap2.score).toBeGreaterThan(snap.score);
  });

  it("probe failure keeps cooldown", () => {
    const { router } = env;
    for (let i = 0; i < 2; i++) router.recordObservation(ok({ completionTokens: 64, streamSpanMs: 60000 }));
    const sel = router.selectAccount({ providerId: "p", modelId: "m", candidates: ["a"] });
    const lease = router.reserve({ layer: "account", providerId: "p", modelId: "m", connectionId: "a", probe: true });
    const mr = router.markProbeResult(lease, ok({ outcome: "error" }));
    expect(mr.accepted).toBe(false);
    const entry = router.snapshot().entries.find((e) => e.key[3] === "a");
    expect(entry.cooledUntil).toBeGreaterThan(env.time());
  });

  it("reset bumps generation and rejects stale observation callbacks", () => {
    const { router } = env;
    const gen = router.getGeneration();
    router.reset();
    expect(router.getGeneration()).toBe(gen + 1);
    expect(router.recordObservation(ok({ generation: gen }))).toMatchObject({ accepted: false, reason: "stale_generation" });
    expect(router.recordObservation(ok({ generation: router.getGeneration() })).accepted).toBe(true);
  });

  it("invalidate drops provider/model state and bumps generation", () => {
    const { router } = env;
    router.recordObservation(ok({}));
    router.recordObservation(ok({ modelId: "other" }));
    router.invalidate({ providerId: "p", modelId: "m" });
    expect(router.snapshot().entries.some((e) => e.key[2] === "other")).toBe(true);
    expect(router.snapshot().entries.some((e) => e.key[2] === "m")).toBe(false);
  });

  it("exact-once release: double release returns false", () => {
    const { router } = env;
    const lease = router.reserve({ layer: "account", providerId: "p", modelId: "m", connectionId: "a" });
    expect(router.release(lease)).toBe(true);
    expect(router.release(lease)).toBe(false);
  });

  it("no stampede: in-flight reservation penalizes repeated picks", () => {
    const { router } = env;
    const picks = [];
    for (let i = 0; i < 3; i++) {
      const r = router.selectAccount({ providerId: "p", modelId: "m", candidates: ["a", "b"] });
      picks.push(r.ordered[0]);
      router.reserve({ layer: "account", providerId: "p", modelId: "m", connectionId: r.ordered[0] });
    }
    expect(new Set(picks).size).toBe(2);
  });

  it("weight cap: candidate never exceeds weightRatioCap times the minimum", () => {
    const { router } = env;
    router.recordObservation(ok({ connectionId: "fast", completionTokens: 6400 }));
    router.recordObservation(ok({ connectionId: "slow", completionTokens: 64, streamSpanMs: 60000 }));
    const snap = router.snapshot();
    const scores = snap.entries.filter((e) => e.key[0] === "account").map((e) => e.score).sort((a, b) => b - a);
    expect(scores[0] / scores[1]).toBeGreaterThan(config.weightRatioCap);
    expect(scores.length).toBe(2);
  });

  it("expiry: stale entries treated as cold after staleTtlMs", () => {
    const { router } = env;
    router.recordObservation(ok({}));
    env.tick(config.staleTtlMs + 1);
    const snap = router.snapshot();
    expect(snap.entries).toHaveLength(0);
  });

  it("eviction: bounded LRU", () => {
    let i = 0;
    const r = createAdaptiveRouter({ now: () => 0, config: { maxKeys: 5 } });
    while (i < 10) {
      r.recordObservation(ok({ connectionId: "c" + i, modelId: "m" + i }));
      i++;
    }
    expect(r.snapshot().entries.length).toBeLessThanOrEqual(5);
  });

  it("cooled probe success above recoveryTpsMargin clears cooldown", () => {
    const { router } = env;
    const slow = { ...ok({}), completionTokens: 64, semanticTtftMs: 500, streamSpanMs: 6000 };
    router.recordObservation(slow);
    router.recordObservation(slow);
    const cooled = router.snapshot().entries.find((e) => e.key[0] === "account");
    expect(cooled.cooledUntil).toBeGreaterThan(0);
    const sel = router.selectAccount({ providerId: "p", modelId: "m", candidates: ["a"] });
    const probeLease = router.reserve({ layer: "account", providerId: "p", modelId: "m", connectionId: "a", probe: true });
    expect(probeLease?.probe).toBe(true);
    expect(sel.probe).toBe("a");
    const fast = { ...ok({}), completionTokens: 1600, semanticTtftMs: 400, streamSpanMs: 4000, generation: probeLease.generation };
    const settled = router.markProbeResult(probeLease, fast);
    expect(settled.accepted).toBe(true);
    const recovered = router.snapshot().entries.find((e) => e.key[0] === "account");
    expect(recovered.cooledUntil).toBe(0);
  });

  it("probe success below recoveryTpsMargin keeps cooldown", () => {
    const { router } = env;
    const slow = { ...ok({}), completionTokens: 64, semanticTtftMs: 500, streamSpanMs: 6000 };
    router.recordObservation(slow);
    router.recordObservation(slow);
    const probeLease = router.reserve({ layer: "account", providerId: "p", modelId: "m", connectionId: "a", probe: true });
    expect(probeLease?.probe).toBe(true);
    const stillSlow = { ...ok({}), completionTokens: 64, semanticTtftMs: 500, streamSpanMs: 6000, generation: probeLease.generation };
    expect(router.markProbeResult(probeLease, stillSlow).accepted).toBe(true);
    expect(router.snapshot().entries.find((e) => e.key[0] === "account").cooledUntil).toBeGreaterThan(0);
  });
});
