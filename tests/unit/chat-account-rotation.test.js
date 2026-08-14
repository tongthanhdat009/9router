import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(), extractApiKey: vi.fn(() => null), isValidApiKey: vi.fn(),
  getProviderCredentials: vi.fn(), markAccountUnavailable: vi.fn(), clearAccountError: vi.fn(),
  getComboModels: vi.fn(), getModelInfo: vi.fn(), handleChatCore: vi.fn(), checkAndRefreshToken: vi.fn(),
  detectRequiredCapabilities: vi.fn(() => new Set()), augmentModelsWithCapacityAdapter: vi.fn(),
  modelSatisfiesHardCapabilities: vi.fn(() => true), handleComboChat: vi.fn(), logAffinity: vi.fn(async () => true),
}));

vi.mock("@/sse/services/auth.js", () => ({ getProviderCredentials: mocks.getProviderCredentials, markAccountUnavailable: mocks.markAccountUnavailable, clearAccountError: mocks.clearAccountError, extractApiKey: mocks.extractApiKey, isValidApiKey: mocks.isValidApiKey }));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));
vi.mock("@/sse/services/model.js", () => ({ getModelInfo: mocks.getModelInfo, getComboModels: mocks.getComboModels, parseModel: () => ({ provider: "codex", model: "gpt-5" }) }));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));
vi.mock("open-sse/services/combo.js", () => ({ handleComboChat: mocks.handleComboChat, handleFusionChat: vi.fn(), detectRequiredCapabilities: mocks.detectRequiredCapabilities }));
vi.mock("open-sse/services/capacityAdapter.js", () => ({ augmentModelsWithCapacityAdapter: mocks.augmentModelsWithCapacityAdapter, withCapacityAdapterStripping: vi.fn((fn) => fn), getActiveAdapterStrategy: vi.fn(), modelSatisfiesHardCapabilities: mocks.modelSatisfiesHardCapabilities }));
vi.mock("open-sse/services/sessionAffinity.js", () => {
  const store = new Map();
  return {
    getRouteAffinity: (sessionId, scope) => (sessionId ? store.get(sessionId + "\x00" + scope) || null : null),
    bindRouteAffinity: (sessionId, scope, route) => { if (sessionId && route) store.set(sessionId + "\x00" + scope, { route }); },
    invalidateRouteAffinity: (sessionId, scope) => { if (sessionId) store.delete(sessionId + "\x00" + scope); },
    getAccountAffinity: vi.fn(() => null),
    bindAccountAffinity: vi.fn(),
    invalidateAccountAffinity: vi.fn(),
    clearSessionAffinity: () => store.clear(),
  };
});
vi.mock("open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: vi.fn(() => null) }));
vi.mock("@/sse/services/tokenRefresh.js", () => ({ updateProviderCredentials: vi.fn(), checkAndRefreshToken: mocks.checkAndRefreshToken }));
vi.mock("open-sse/services/projectId.js", () => ({ getProjectIdForConnection: vi.fn() }));
vi.mock("@/sse/utils/logger.js", () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn(), errorLine: vi.fn(), maskKey: vi.fn(() => "masked"), request: vi.fn() }));
vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "http://headroom.local" }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn(async () => null) }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));

vi.mock("@/lib/affinityLogger.js", () => ({ logAffinity: mocks.logAffinity }));

const { handleChat } = await import("@/sse/handlers/chat.js");

function chatRequest() {
  return new Request("https://router.test/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "codex/gpt-5", messages: [{ role: "user", content: "hi" }] }) });
}

describe("chat account-loop rotation on synthetic 503", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });
    mocks.getComboModels.mockResolvedValue(null);
    mocks.getModelInfo.mockResolvedValue({ provider: "codex", model: "gpt-5" });
    mocks.augmentModelsWithCapacityAdapter.mockImplementation((models) => models);
    mocks.checkAndRefreshToken.mockImplementation(async (_p, creds) => creds);
    mocks.getProviderCredentials.mockResolvedValue(null);
  });

  it("selects second account after one synthetic 503, returns client 200", async () => {
    mocks.getProviderCredentials.mockResolvedValueOnce({ connectionId: "conn-a", connectionName: "Acc A", providerSpecificData: {} }).mockResolvedValueOnce({ connectionId: "conn-b", connectionName: "Acc B", providerSpecificData: {} });
    mocks.handleChatCore.mockResolvedValueOnce({ success: false, status: 503, error: "capacity", response: new Response("err", { status: 503 }) }).mockResolvedValueOnce({ success: true, response: new Response("data: ok\n\n", { status: 200 }) });
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true });

    const response = await handleChat(chatRequest());

    expect(response.status).toBe(200);
    expect(mocks.markAccountUnavailable).toHaveBeenCalledWith("conn-a", 503, expect.any(String), "codex", "gpt-5", undefined);
    expect(mocks.getProviderCredentials).toHaveBeenNthCalledWith(2, "codex", new Set(["conn-a"]), "gpt-5", { preferredConnectionId: null });
  });

  it("honors fill-first account affinity, clears it after failure, then rebinds the fallback", async () => {
    const { bindAccountAffinity, getAccountAffinity, clearSessionAffinity } = await import("@/sse/services/sessionAffinity.js");
    clearSessionAffinity();
    bindAccountAffinity("session-1", "codex", "gpt-5", "conn-a");
    const selectorCalls = [];
    const accounts = [{ connectionId: "conn-a", connectionName: "Acc A", providerSpecificData: {} }, { connectionId: "conn-b", connectionName: "Acc B", providerSpecificData: {} }, { connectionId: "conn-b", connectionName: "Acc B", providerSpecificData: {} }];
    mocks.getProviderCredentials.mockImplementation(async (provider, excluded, model, options) => {
      selectorCalls.push({ provider, excluded: new Set(excluded), model, options });
      return accounts.shift();
    });
    mocks.handleChatCore.mockResolvedValueOnce({ success: false, status: 503, error: "capacity", response: new Response("err", { status: 503 }) }).mockImplementation(async ({ onRequestSuccess }) => { await onRequestSuccess(); return { success: true, response: new Response("ok", { status: 200 }) }; });
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true });
    const request = () => new Request("https://router.test/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", "x-session-id": "session-1" }, body: JSON.stringify({ model: "codex/gpt-5", messages: [{ role: "user", content: "hi" }] }) });

    expect((await handleChat(request())).status).toBe(200);
    expect(selectorCalls).toEqual([
      { provider: "codex", excluded: new Set(), model: "gpt-5", options: { preferredConnectionId: "conn-a" } },
      { provider: "codex", excluded: new Set(["conn-a"]), model: "gpt-5", options: { preferredConnectionId: null } },
    ]);
    expect(getAccountAffinity("session-1", "codex", "gpt-5")?.connectionId).toBe("conn-b");

    expect((await handleChat(request())).status).toBe(200);
    expect(selectorCalls.at(-1)).toEqual({ provider: "codex", excluded: new Set(), model: "gpt-5", options: { preferredConnectionId: "conn-b" } });
  });

  it("invalidates stored route affinity when it misses required hard capabilities", async () => {
    mocks.getComboModels.mockResolvedValue(["openai/gpt-5", "anthropic/claude-sonnet-4-6"]);
    mocks.getModelInfo.mockResolvedValue({ provider: null, model: null });
    mocks.detectRequiredCapabilities.mockReturnValue(new Set(["vision"]));
    mocks.augmentModelsWithCapacityAdapter.mockImplementation((models) => models);
    // stored route "openai/gpt-5" (no vision) — must NOT be passed as preferredRoute
    mocks.modelSatisfiesHardCapabilities.mockReturnValue(false);
    const { bindRouteAffinity, clearSessionAffinity } = await import("@/sse/services/sessionAffinity.js");
    clearSessionAffinity();
    bindRouteAffinity("session-1", "my-combo", "openai/gpt-5");
    const { handleComboChat } = await import("open-sse/services/combo.js");
    handleComboChat.mockResolvedValue(new Response("ok", { status: 200 }));

    const response = await handleChat(new Request("https://router.test/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": "session-1" },
      body: JSON.stringify({ model: "my-combo", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }] }),
    }));

    expect(response.status).toBe(200);
    expect(handleComboChat).toHaveBeenCalledTimes(1);
    expect(handleComboChat.mock.calls[0][0].preferredRoute).toBeNull();
  });

  it("finalizes affinity.request exactly once for malformed JSON", async () => {
    const response = await handleChat(new Request("https://router.test/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not-json" }));
    expect(response.status).toBe(400);
    expect(mocks.logAffinity).toHaveBeenCalledTimes(1);
    expect(mocks.logAffinity.mock.calls[0][0]).toBe("affinity.request");
    expect(mocks.logAffinity.mock.calls[0][1]).toMatchObject({ status: 400, requestId: expect.stringMatching(/^req-/), finalized: true, usage: null });
  });

  it("finalizes a no-eligible-account affinity mismatch with selected null", async () => {
    const { bindAccountAffinity, clearSessionAffinity } = await import("@/sse/services/sessionAffinity.js");
    clearSessionAffinity();
    bindAccountAffinity("session-1", "codex", "gpt-5", "conn-a");
    mocks.getProviderCredentials.mockResolvedValue(null);
    const response = await handleChat(new Request("https://router.test/v1/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json", "x-session-id": "session-1" },
      body: JSON.stringify({ model: "codex/gpt-5", messages: [{ role: "user", content: "hi" }] }),
    }));
    expect(response.status).toBe(404);
    expect(mocks.logAffinity).toHaveBeenCalledWith("affinity.invariant_violation", expect.objectContaining({ selected: null, preferredConnectionId: "conn-a" }));
    expect(mocks.logAffinity).toHaveBeenLastCalledWith("affinity.request", expect.objectContaining({ status: 404, usage: null }));
  });

  it("passes all safe affinity diagnostics into chatCore", async () => {
    mocks.getProviderCredentials.mockResolvedValue({ connectionId: "conn-a", connectionName: "Acc A", providerSpecificData: {} });
    mocks.handleChatCore.mockResolvedValue({ success: true, response: new Response("ok", { status: 200 }) });
    await handleChat(new Request("https://router.test/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": "session-1" },
      body: JSON.stringify({ model: "codex/gpt-5", messages: [{ role: "user", content: "hi" }] }),
    }));
    expect(mocks.handleChatCore).toHaveBeenCalledWith(expect.objectContaining({
      affinity: expect.objectContaining({
        sessionHash: expect.any(String), routeAffinityHit: false, accountAffinityHit: false,
        routeSwitch: false, accountSwitch: false, rebindReason: null,
      }),
    }));
  });

  it("combo Codex no-credential first attempt defers finalization; Claude success emits the single terminal event", async () => {
    mocks.getComboModels.mockResolvedValue(["codex/gpt-5", "anthropic/claude"]);
    mocks.getModelInfo.mockImplementation(async (model) => model.startsWith("codex/") ? { provider: "codex", model: "gpt-5" } : { provider: "anthropic", model: "claude" });
    mocks.handleComboChat.mockImplementation(async ({ handleSingleModel }) => {
      const codexFailure = await handleSingleModel({ model: "combo" }, "codex/gpt-5");
      expect(codexFailure.status).toBe(404);
      expect(mocks.logAffinity).not.toHaveBeenCalledWith("affinity.request", expect.anything());
      return handleSingleModel({ model: "combo" }, "anthropic/claude");
    });
    mocks.getProviderCredentials.mockResolvedValueOnce(null).mockResolvedValueOnce({ connectionId: "claude-c", connectionName: "Claude C", providerSpecificData: {} });
    mocks.handleChatCore.mockImplementation(async ({ onRequestSuccess }) => {
      await onRequestSuccess();
      return { success: true, response: new Response("ok", { status: 200 }) };
    });
    const { bindRouteAffinity, getRouteAffinity, clearSessionAffinity } = await import("@/sse/services/sessionAffinity.js");
    clearSessionAffinity();
    bindRouteAffinity("session-1", "combo", "codex/gpt-5");
    const response = await handleChat(new Request("https://router.test/v1/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json", "x-session-id": "session-1" },
      body: JSON.stringify({ model: "combo", messages: [{ role: "user", content: "hi" }] }),
    }));
    expect(response.status).toBe(200);
    const summaries = mocks.logAffinity.mock.calls.filter(([event]) => event === "affinity.request");
    expect(summaries).toHaveLength(1);
    expect(summaries[0][1]).toMatchObject({ status: 200, selection: expect.objectContaining({ provider: "anthropic", model: "claude", connectionId: "claude-c" }), usage: null });
    expect(getRouteAffinity("session-1", "combo")?.route).toBe("anthropic/claude");
  });

  it("combo Codex all-accounts-fail → Claude success: one terminal event with usage, route rebind, routeFallbackCount=1", async () => {
    mocks.getComboModels.mockResolvedValue(["codex/gpt-5", "anthropic/claude"]);
    mocks.getModelInfo.mockImplementation(async (model) => model.startsWith("codex/") ? { provider: "codex", model: "gpt-5" } : { provider: "anthropic", model: "claude" });
    mocks.handleComboChat.mockImplementation(async ({ handleSingleModel }) => {
      const codexFailure = await handleSingleModel({ model: "combo" }, "codex/gpt-5");
      expect(codexFailure.status).toBe(503);
      expect(mocks.logAffinity).not.toHaveBeenCalledWith("affinity.request", expect.anything());
      return handleSingleModel({ model: "combo" }, "anthropic/claude");
    });
    const codexAccounts = [ { connectionId: "codex-a", connectionName: "Acc A", providerSpecificData: {} }, { connectionId: "codex-b", connectionName: "Acc B", providerSpecificData: {} }, null ];
    mocks.getProviderCredentials.mockImplementation(async (provider) => {
      if (provider !== "codex") return { connectionId: "claude-c", connectionName: "Claude C", providerSpecificData: {} };
      return codexAccounts.shift();
    });
    mocks.handleChatCore.mockImplementation(async ({ modelInfo, onRequestSuccess, affinityDiagnostics, finalizeAffinityRequest }) => {
      if (modelInfo.provider !== "codex") {
        await onRequestSuccess();
        const usage = { inputTokens: 9, cachedTokens: null, cacheCreationTokens: null, outputTokens: 4 };
        affinityDiagnostics.usage = usage;
        finalizeAffinityRequest({ status: 200, usage });
        return { success: true, response: new Response("ok", { status: 200 }) };
      }
      return { success: false, status: 503, error: "capacity", response: new Response("err", { status: 503 }) };
    });
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true });
    const { bindRouteAffinity, getRouteAffinity, clearSessionAffinity } = await import("@/sse/services/sessionAffinity.js");
    clearSessionAffinity();
    bindRouteAffinity("session-1", "combo", "codex/gpt-5");
    const response = await handleChat(new Request("https://router.test/v1/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json", "x-session-id": "session-1" },
      body: JSON.stringify({ model: "combo", messages: [{ role: "user", content: "hi" }] }),
    }));
    expect(response.status).toBe(200);
    const summaries = mocks.logAffinity.mock.calls.filter(([event]) => event === "affinity.request");
    expect(summaries).toHaveLength(1);
    expect(summaries[0][1]).toMatchObject({
      status: 200,
      selection: expect.objectContaining({ provider: "anthropic", model: "claude", connectionId: "claude-c" }),
      fallback: expect.objectContaining({ routeFallbackCount: 1, accountFallbackCount: 2 }),
      usage: { inputTokens: 9, cachedTokens: null, cacheCreationTokens: null, outputTokens: 4 },
    });
    expect(mocks.logAffinity).toHaveBeenCalledWith("affinity.rebind", expect.objectContaining({ layer: "route", fromModel: "codex/gpt-5", toModel: "anthropic/claude", reason: "route_fallback" }));
    expect(getRouteAffinity("session-1", "combo")?.route).toBe("anthropic/claude");
  });

  it("returns 503 only after every account is exhausted", async () => {
    mocks.getProviderCredentials.mockResolvedValueOnce({ connectionId: "conn-a", connectionName: "Acc A", providerSpecificData: {} }).mockResolvedValueOnce({ connectionId: "conn-b", connectionName: "Acc B", providerSpecificData: {} }).mockResolvedValueOnce(null);
    mocks.handleChatCore.mockResolvedValue({ success: false, status: 503, error: "capacity", response: new Response("err", { status: 503 }) });
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true });

    const response = await handleChat(chatRequest());

    expect(response.status).toBe(503);
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(3);
    expect(mocks.getProviderCredentials).toHaveBeenLastCalledWith("codex", new Set(["conn-a", "conn-b"]), "gpt-5", { preferredConnectionId: null });
  });
});