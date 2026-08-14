import { describe, expect, it, vi } from "vitest";
vi.mock("../../src/lib/usageDb.js", () => ({ saveRequestUsage: vi.fn(() => Promise.resolve()), appendRequestLog: vi.fn(), saveRequestDetail: vi.fn() }));
vi.mock("../../open-sse/utils/stream.js", () => ({ COLORS: { green: "", reset: "" } }));
import { saveUsageStats } from "../../open-sse/handlers/chatCore/requestDetail.js";

describe("affinity usage finalizer", () => {
  it("normalizes cache usage then finalizes exactly once", () => {
    const diagnostics = { finalized: false, usage: null }; const finalize = vi.fn(({ usage }) => { if (diagnostics.finalized) return; diagnostics.finalized = true; diagnostics.usage = usage; });
    saveUsageStats({ provider: "codex", model: "x", tokens: { input_tokens: 10, output_tokens: 3, cached_tokens: 7 }, affinityDiagnostics: diagnostics, finalizeAffinityRequest: finalize, silent: true });
    saveUsageStats({ provider: "codex", model: "x", tokens: { input_tokens: 10, output_tokens: 3, cached_tokens: 7 }, affinityDiagnostics: diagnostics, finalizeAffinityRequest: finalize, silent: true });
    expect(finalize).toHaveBeenCalledTimes(1); expect(diagnostics.usage).toEqual({ inputTokens: 10, cachedTokens: 7, cacheCreationTokens: null, outputTokens: 3 });
  });
  it("keeps absent cache usage null after canonicalization", () => {
    const diagnostics = { finalized: false, usage: null }; const finalize = vi.fn(({ usage }) => { diagnostics.finalized = true; diagnostics.usage = usage; });
    saveUsageStats({ provider: "x", model: "x", tokens: { input_tokens: 10, output_tokens: 3 }, affinityDiagnostics: diagnostics, finalizeAffinityRequest: finalize, silent: true });
    expect(diagnostics.usage).toEqual({ inputTokens: 10, cachedTokens: null, cacheCreationTokens: null, outputTokens: 3 });
  });
  it("does not invent usage for missing values", () => {
    const finalize = vi.fn(); saveUsageStats({ provider: "x", model: "x", tokens: null, finalizeAffinityRequest: finalize, affinityDiagnostics: {} }); expect(finalize).not.toHaveBeenCalled();
  });
});
