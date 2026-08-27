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

describe("affinity request-count limit", () => {
  beforeEach(clearSessionAffinity);

  it("route affinity starts at requestCount 1 and preserves it on same-route rebind", () => {
    bindRouteAffinity("S", "combo", "a/model");
    expect(getRouteAffinity("S", "combo")?.requestCount).toBe(1);
    bindRouteAffinity("S", "combo", "a/model", { requestCount: 5 });
    expect(getRouteAffinity("S", "combo")?.requestCount).toBe(5);
    // Back-compat path without opts preserves existing count for same route
    bindRouteAffinity("S", "combo", "a/model");
    expect(getRouteAffinity("S", "combo")?.requestCount).toBe(5);
  });

  it("route affinity resets requestCount to 1 on route switch", () => {
    bindRouteAffinity("S", "combo", "a/model", { requestCount: 10 });
    bindRouteAffinity("S", "combo", "b/model");
    expect(getRouteAffinity("S", "combo")?.requestCount).toBe(1);
    expect(getRouteAffinity("S", "combo")?.route).toBe("b/model");
  });

  it("route affinity with explicit requestCount clamps to >=1", () => {
    bindRouteAffinity("S", "combo", "a/model", { requestCount: 0 });
    expect(getRouteAffinity("S", "combo")?.requestCount).toBe(1);
    bindRouteAffinity("S", "combo", "a/model", { requestCount: -5 });
    expect(getRouteAffinity("S", "combo")?.requestCount).toBe(1);
  });

  it("account affinity starts at requestCount 1 and increments via explicit opts", () => {
    bindAccountAffinity("S", "codex", "gpt", "A");
    expect(getAccountAffinity("S", "codex", "gpt")?.requestCount).toBe(1);
    bindAccountAffinity("S", "codex", "gpt", "A", { requestCount: 3 });
    expect(getAccountAffinity("S", "codex", "gpt")?.requestCount).toBe(3);
    // Same connection without opts preserves count
    bindAccountAffinity("S", "codex", "gpt", "A");
    expect(getAccountAffinity("S", "codex", "gpt")?.requestCount).toBe(3);
  });

  it("account affinity resets to 1 on connection switch", () => {
    bindAccountAffinity("S", "codex", "gpt", "A", { requestCount: 7 });
    bindAccountAffinity("S", "codex", "gpt", "B");
    expect(getAccountAffinity("S", "codex", "gpt")?.requestCount).toBe(1);
    expect(getAccountAffinity("S", "codex", "gpt")?.connectionId).toBe("B");
  });

  it("preserves slowStreak and escapeNext when bumping requestCount for same route", () => {
    bindRouteAffinity("S", "combo", "a/model");
    // Arm escape via throughput samples
    recordRouteAffinityThroughput({ sessionId: "S", routeScope: "combo", route: "a/model", completionTokens: 64, firstSemanticGenerationAt: 1, streamEndAt: 8001, estimated: false });
    recordRouteAffinityThroughput({ sessionId: "S", routeScope: "combo", route: "a/model", completionTokens: 64, firstSemanticGenerationAt: 1, streamEndAt: 8001, estimated: false });
    expect(getRouteAffinity("S", "combo")?.escapeNext).toBe(true);
    const prior = getRouteAffinity("S", "combo");
    bindRouteAffinity("S", "combo", "a/model", { requestCount: (prior.requestCount ?? 1) + 1 });
    expect(getRouteAffinity("S", "combo")).toMatchObject({ route: "a/model", escapeNext: true, slowStreak: 2 });
  });

  it("no corruption under repeated invalidates and rebinds at boundary", () => {
    bindRouteAffinity("S", "combo", "a/model", { requestCount: 20 });
    invalidateRouteAffinity("S", "combo");
    expect(getRouteAffinity("S", "combo")).toBeNull();
    bindRouteAffinity("S", "combo", "b/model", { requestCount: 1 });
    expect(getRouteAffinity("S", "combo")).toMatchObject({ route: "b/model", requestCount: 1 });
    bindAccountAffinity("S", "codex", "gpt", "A", { requestCount: 20 });
    invalidateAccountAffinity("S", "codex", "gpt");
    expect(getAccountAffinity("S", "codex", "gpt")).toBeNull();
    bindAccountAffinity("S", "codex", "gpt", "B", { requestCount: 1 });
    expect(getAccountAffinity("S", "codex", "gpt")).toMatchObject({ connectionId: "B", requestCount: 1 });
  });
});
