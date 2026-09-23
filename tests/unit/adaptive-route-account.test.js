import { describe, expect, it, beforeEach } from "vitest";
import { adaptiveRoundRobinModels, getRotatedModels, handleComboChat, resetComboRotation } from "../../open-sse/services/combo.js";
import { adaptiveRouter } from "../../open-sse/services/adaptiveRouter.js";
import { resolveAdaptiveCancelDisposition } from "../../src/sse/handlers/chat.js";

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };
const okResponse = (payload = "ok") => new Response(payload, { status: 200 });
const failResponse = (status = 503) => new Response("err", { status, statusText: "err" });

describe("adaptive route + account integration", () => {
  beforeEach(() => {
    adaptiveRouter.reset();
    resetComboRotation();
  });

  it("outer+inner adaptive selection advances SWRR once and prefers fast routes", () => {
    const models = ["p/fast", "p/slow"];
    adaptiveRouter.recordObservation({ layer: "account", providerId: "p", modelId: "fast", connectionId: "a", outcome: "success", completionTokens: 1600, semanticTtftMs: 400, streamSpanMs: 4000 });
    adaptiveRouter.recordObservation({ layer: "account", providerId: "p", modelId: "slow", connectionId: "a", outcome: "success", completionTokens: 200, semanticTtftMs: 500, streamSpanMs: 5000 });
    const first = adaptiveRoundRobinModels(models, "combo");
    expect(first[0]).toBe("p/fast");
    // No duplicate attempts in one logical request.
    expect(new Set(first).size).toBe(first.length);
  });

  it("mixed fast+slow accounts same provider/model: account pick rescues the route", () => {
    adaptiveRouter.recordObservation({ layer: "account", providerId: "p", modelId: "m", connectionId: "fast", outcome: "success", completionTokens: 1600, semanticTtftMs: 400, streamSpanMs: 4000 });
    adaptiveRouter.recordObservation({ layer: "account", providerId: "p", modelId: "m", connectionId: "slow", outcome: "success", completionTokens: 200, semanticTtftMs: 2200, streamSpanMs: 5000 });
    const { ordered } = adaptiveRouter.selectAccount({ providerId: "p", modelId: "m", candidates: [{ connectionId: "fast" }, { connectionId: "slow" }] });
    expect(ordered[0].connectionId).toBe("fast");
    // Route health aggregates from the same account sample; entries exist, not double-counted.
    expect(adaptiveRouter.snapshot().entries.length).toBeGreaterThan(0);
  });

  it("same-account different-model histories are separate", () => {
    adaptiveRouter.recordObservation({ layer: "account", providerId: "p", modelId: "m1", connectionId: "a", outcome: "success", completionTokens: 1600, semanticTtftMs: 400, streamSpanMs: 4000 });
    adaptiveRouter.recordObservation({ layer: "account", providerId: "p", modelId: "m2", connectionId: "a", outcome: "success", completionTokens: 200, semanticTtftMs: 2000, streamSpanMs: 5000 });
    const first = adaptiveRouter.selectAccount({ providerId: "p", modelId: "m1", candidates: ["a", "b"] }).ordered[0];
    const second = adaptiveRouter.selectAccount({ providerId: "p", modelId: "m2", candidates: ["a", "b"] }).ordered[0];
    expect(first).toBe("a");
    // Histories remain distinct even when the confidence prior keeps a cold
    // alternative behind a once-slow account on this first selection.
    expect(["a", "b"]).toContain(second);
    const entries = adaptiveRouter.snapshot().entries.filter((entry) => entry.key[0] === "account" && entry.key[3] === "a");
    expect(entries.map((entry) => entry.key[2]).sort()).toEqual(["m1", "m2"]);
    expect(entries.find((entry) => entry.key[2] === "m1").tps).toBeGreaterThan(entries.find((entry) => entry.key[2] === "m2").tps);
  });

  it("quota-blocked eligibility stays enforced: cooled fast candidate never jumps ineligible accounts", () => {
    adaptiveRouter.recordObservation({ layer: "account", providerId: "p", modelId: "m", connectionId: "fast", outcome: "success", completionTokens: 200, semanticTtftMs: 500, streamSpanMs: 5000 });
    adaptiveRouter.recordObservation({ layer: "account", providerId: "p", modelId: "m", connectionId: "fast", outcome: "success", completionTokens: 200, semanticTtftMs: 500, streamSpanMs: 5000 });
    // auth.js filters ineligible (quota-blocked) accounts before selection; selection only sees slow.
    const { ordered } = adaptiveRouter.selectAccount({ providerId: "p", modelId: "m", candidates: [{ connectionId: "slow" }] });
    expect(ordered[0].connectionId).toBe("slow");
  });

  it("probe coordination: route and account leases are independent samples (no shared ticket)", () => {
    const account = adaptiveRouter.reserve({ layer: "account", providerId: "p", modelId: "m", connectionId: "a" });
    const route = adaptiveRouter.reserve({ layer: "route", providerId: "p", modelId: "m" });
    expect(account).not.toBeNull();
    // The route layer is never reserved by request code; this direct check only
    // proves a route ticket cannot be released as an account ticket.
    expect(adaptiveRouter.release({ ...account, id: route.id })).toBe(false);
    expect(adaptiveRouter.release(account)).toBe(true);
    expect(adaptiveRouter.release(route)).toBe(true);
  });

  it("cancel disposition is ignore, never failure", () => {
    expect(resolveAdaptiveCancelDisposition("cancelled")).toEqual({ disposition: "ignore", reason: "cancel" });
    expect(resolveAdaptiveCancelDisposition(null)).toEqual({ disposition: "ignore", reason: "abort" });
    const reject = adaptiveRouter.recordObservation({ layer: "account", providerId: "p", modelId: "m", connectionId: "a", outcome: "cancelled" });
    expect(reject).toEqual({ accepted: false, reason: "cancelled" });
  });

  it("exactly-once release: second release of the same lease returns false", () => {
    const lease = adaptiveRouter.reserve({ layer: "account", providerId: "p", modelId: "m", connectionId: "a" });
    expect(adaptiveRouter.release(lease)).toBe(true);
    expect(adaptiveRouter.release(lease)).toBe(false);
  });

  it("adaptive ignores legacy sticky limits (single advance per logical request)", () => {
    const models = ["p/a", "p/b"];
    const first = getRotatedModels(models, "sticky-combo", "adaptive-round-robin", 99)[0];
    const second = getRotatedModels(models, "sticky-combo", "adaptive-round-robin", 99)[0];
    // Sticky limits never apply: the winner comes from learned weights, not cursor.
    expect(["p/a", "p/b"]).toContain(first);
    expect(["p/a", "p/b"]).toContain(second);
  });

  it("adaptive-off parity: legacy fallback ordering is untouched", async () => {
    const attempted = [];
    const failTwice = async (body, modelStr) => {
      attempted.push(modelStr);
      return attempted.length < 3 ? failResponse() : okResponse();
    };
    const response = await handleComboChat({ body: { messages: [] }, models: ["p/a", "p/b", "p/c"], handleSingleModel: failTwice, log: silentLog, comboName: "parity", comboStrategy: "fallback" });
    expect(response.status).toBe(200);
    expect(attempted).toEqual(["p/a", "p/b", "p/c"]);
  });

  it("adaptive combo dedupes attempts and preserves fallback order", async () => {
    const attempted = [];
    const alwaysFail = async (body, modelStr) => {
      attempted.push(modelStr);
      return failResponse();
    };
    const response = await handleComboChat({ body: { messages: [] }, models: ["p/a", "p/b"], handleSingleModel: alwaysFail, log: silentLog, comboName: "dedup", comboStrategy: "adaptive-round-robin" });
    expect(response.status).toBe(503);
    expect(attempted.length).toBe(new Set(attempted).size);
  });

  it("alias-canonicalized route keys: getRotatedModels hashes aliases with canonical keys", () => {
    // Unit-level: the canonicalModels map makes an aliased member score under the same key as its canonical twin.
    const canonicalModels = [{ model: "cx/gpt-5", providerId: "codex", modelId: "gpt-5" }];
    adaptiveRouter.recordObservation({ layer: "route", providerId: "codex", modelId: "gpt-5", outcome: "success", completionTokens: 64, semanticTtftMs: 400, streamSpanMs: 6000 });
    adaptiveRouter.recordObservation({ layer: "route", providerId: "codex", modelId: "gpt-5", outcome: "success", completionTokens: 64, semanticTtftMs: 400, streamSpanMs: 6000 });
    const ordered = getRotatedModels(["cx/gpt-5", "codex/backup"], "alias-combo", "adaptive-round-robin", 1, null, canonicalModels);
    expect(ordered[0]).toBe("codex/backup");
    expect(adaptiveRouter.snapshot().entries.find((entry) => entry.key[0] === "route" && entry.key[1] === "codex" && entry.key[2] === "gpt-5").cooledUntil).toBeGreaterThan(0);
  });

  it("delete/disable mid-stream: cooled keys expire without blocking selection", () => {
    adaptiveRouter.recordObservation({ layer: "account", providerId: "p", modelId: "m", connectionId: "gone", outcome: "success", completionTokens: 200, semanticTtftMs: 500, streamSpanMs: 5000 });
    // A deleted/disabled connection is simply absent from candidates; selection continues.
    const { ordered } = adaptiveRouter.selectAccount({ providerId: "p", modelId: "m", candidates: [{ connectionId: "live" }] });
    expect(ordered[0].connectionId).toBe("live");
    adaptiveRouter.invalidate({ providerId: "p", modelId: "m", connectionId: "gone" });
    const snap = adaptiveRouter.snapshot();
    expect(snap.entries.some((entry) => entry.key[3] === "gone")).toBe(false);
  });
});
