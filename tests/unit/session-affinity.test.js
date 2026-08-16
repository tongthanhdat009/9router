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

  it("recovers on healthy TPS and ignores stale or unqualified samples", () => {
    bindRouteAffinity("S", "combo", "a/model");
    sample("a/model"); sample("a/model");
    sample("a/model", 180, 10000);
    expect(getRouteAffinity("S", "combo")).toMatchObject({ slowStreak: 0, escapeNext: false });
    bindRouteAffinity("S", "combo", "b/model");
    sample("a/model");
    sample("b/model", 63);
    expect(getRouteAffinity("S", "combo")).toMatchObject({ route: "b/model", slowStreak: 0, escapeNext: false });
  });
});
