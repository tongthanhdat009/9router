import { beforeEach, describe, expect, it } from "vitest";
import {
  bindAccountAffinity,
  bindRouteAffinity,
  clearSessionAffinity,
  getAccountAffinity,
  getRouteAffinity,
  invalidateAccountAffinity,
  invalidateRouteAffinity,
  consumeRouteAffinityEscape,
  recordRouteAffinityThroughput,
} from "../../src/sse/services/sessionAffinity.js";

describe("session affinity", () => {
  beforeEach(clearSessionAffinity);

  it("pins account by session/provider/model and removes stale bindings", () => {
    bindAccountAffinity("S", "codex", "gpt", "A");
    expect(getAccountAffinity("S", "codex", "gpt")?.connectionId).toBe("A");
    expect(getAccountAffinity("S", "codex", "other")).toBeNull();
    invalidateAccountAffinity("S", "codex", "gpt");
    expect(getAccountAffinity("S", "codex", "gpt")).toBeNull();
  });

  it("pins combo route independently and invalidates on failover", () => {
    bindRouteAffinity("S", "combo", "codex/gpt");
    expect(getRouteAffinity("S", "combo")?.route).toBe("codex/gpt");
    invalidateRouteAffinity("S", "combo");
    expect(getRouteAffinity("S", "combo")).toBeNull();
  });
  it("no session identity -> no affinity -> falls through", () => {
    bindAccountAffinity("S", "codex", "gpt", "A");
    expect(getAccountAffinity(null, "codex", "gpt")).toBeNull();
    expect(getRouteAffinity(null, "combo")).toBeNull();
  });

});

describe("route throughput escape", () => {
  beforeEach(clearSessionAffinity);

  const sample = (route, completionTokens = 64, elapsed = 8000) => recordRouteAffinityThroughput({
    sessionId: "S", routeScope: "combo", route, completionTokens,
    firstSemanticGenerationAt: 1, streamEndAt: 1 + elapsed, estimated: false,
  });

  it("escapes only after sustained slow samples and consumes once", () => {
    bindRouteAffinity("S", "combo", "a/model");
    sample("a/model");
    expect(getRouteAffinity("S", "combo")).toMatchObject({ slowStreak: 1, escapeNext: false });
    sample("a/model");
    expect(consumeRouteAffinityEscape("S", "combo")).toEqual({ route: "a/model" });
    expect(consumeRouteAffinityEscape("S", "combo")).toBeNull();
  });

  it("reports samples, ignored reasons, escape arming, and recovery", () => {
    bindRouteAffinity("S", "combo", "a/model");
    expect(sample("a/model")).toMatchObject({ tps: 8, slowStreak: 1, escapeArmed: false });
    expect(sample("a/model")).toMatchObject({ tps: 8, slowStreak: 2, escapeArmed: true });
    expect(sample("a/model", 180, 10000)).toMatchObject({ tps: 18, slowStreak: 0, recovered: true });
    expect(recordRouteAffinityThroughput({ sessionId: "S", routeScope: "combo", route: "a/model", completionTokens: 63, firstSemanticGenerationAt: 1, streamEndAt: 8001, estimated: false })).toEqual({ ignored: "insufficient_tokens" });
    bindRouteAffinity("S", "combo", "b/model");
    expect(sample("a/model")).toEqual({ ignored: "stale_route" });
    expect(getRouteAffinity("S", "combo")).toMatchObject({ route: "b/model", slowStreak: 0, escapeNext: false });
  });

  it("floors the time span so bursty short samples cannot inflate TPS", () => {
    bindRouteAffinity("S", "combo", "a/model");
    // 119 tokens delivered in a 43ms burst: without the 1s floor this would read 2767 t/s.
    expect(recordRouteAffinityThroughput({ sessionId: "S", routeScope: "combo", route: "a/model", completionTokens: 119, firstSemanticGenerationAt: 1, streamEndAt: 44, estimated: false }))
      .toMatchObject({ tps: 119, slowStreak: 0, escapeArmed: false });
    expect(recordRouteAffinityThroughput({ sessionId: "S", routeScope: "combo", route: "a/model", completionTokens: 119, firstSemanticGenerationAt: 1, streamEndAt: 44, estimated: false }))
      .toMatchObject({ tps: 119, slowStreak: 0, escapeArmed: false });
  });
});
