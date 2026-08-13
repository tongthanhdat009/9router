import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Two-call sticky terminal check: first unrecoverable = no marker, second = write.

const { executeMock, refreshMock } = vi.hoisted(() => ({ executeMock: vi.fn(), refreshMock: vi.fn() }));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: false, execute: executeMock, refreshCredentials: refreshMock }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({ logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(), logError: vi.fn() }),
}));

vi.mock("@/lib/usageDb.js", () => ({ trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}), saveRequestDetail: vi.fn(async () => {}) }));

describe("token-refresh sticky terminal state", () => {
  let updateSpy, wrapper;

  beforeEach(async () => {
    vi.resetModules();
    vi.mock("@/lib/localDb.js", () => ({
      updateProviderConnection: vi.fn(async () => ({})),
      getProviderConnectionById: vi.fn(),
      getProviderConnections: vi.fn(() => Promise.resolve([])),
    }));
    // Swap the deep handler to emit unrecoverable twice
    vi.doMock("open-sse/services/oauthCredentialManager.js", async () => {
      const actual = await vi.importActual("open-sse/services/oauthCredentialManager.js");
      return {
        ...actual,
        refreshProviderCredentials: vi.fn(async () => ({ error: "unrecoverable_refresh_error", code: "refresh_token_invalidated" })),
        shouldRefreshCredentials: actual.shouldRefreshCredentials,
      };
    });
    // Stub projectId fetch to avoid side effects and ensure simple path
    vi.doMock("open-sse/services/projectId.js", async () => {
      const actual = await vi.importActual("open-sse/services/projectId.js");
      return { ...actual, getProjectIdForConnection: async () => null, invalidateProjectId: () => {}, removeConnection: () => {} };
    });
    global.BroadcastChannel = global.BroadcastChannel || class { constructor(){ } postMessage(){} close(){} };
    wrapper = await import("../../src/sse/services/tokenRefresh.js");
    wrapper.resetUnrecoverableRefreshFailuresForTests();
    const { updateProviderConnection } = await import("../../src/lib/localDb.js");
    updateSpy = updateProviderConnection;
  });

  afterEach(() => {
    vi.unstubAllEnvs?.();
    vi.resetModules();
  });

  it("first unrecoverable does not mark", async () => {
    const creds = { provider: "codex", connectionId: "c1", refreshToken: "rt", providerSpecificData: {} };
    const out = await wrapper.checkAndRefreshToken("codex", creds, { force: true });
    expect(out._needsReauth).toBeUndefined();
    expect(updateSpy).not.toHaveBeenCalledWith("c1", expect.objectContaining({ lastErrorType: "token_refresh_failed" }));
  });

  it("second consecutive unrecoverable writes reauth marker and returns _needsReauth", async () => {
    const creds = { provider: "codex", connectionId: "c2", refreshToken: "rt2", providerSpecificData: {} };
    await wrapper.checkAndRefreshToken("codex", creds, { force: true });
    updateSpy.mockClear();
    const out = await wrapper.checkAndRefreshToken("codex", creds, { force: true });
    expect(out._needsReauth).toBe(true);
    expect(updateSpy).toHaveBeenCalledWith("c2", expect.objectContaining({ lastErrorType: "token_refresh_failed" }));
    const arg = updateSpy.mock.calls[0][1];
    expect(arg.reauthRequiredAt).toBeTruthy();
  });

  it("success clears marker via persist helper", async () => {
    const spy2 = updateSpy;
    // call helpers directly
    await wrapper.persistRefreshedCredentials("c3", { accessToken: "a", refreshToken: "rt" }, { chatgptAccountId: "w1" });
    expect(spy2).toHaveBeenCalledWith("c3", expect.objectContaining({ accessToken: "a" }));
  });
});

describe("reactive 401 terminal refresh failure", () => {
  let updateSpy, wrapper, chatCore;

  beforeEach(async () => {
    vi.resetModules();
    vi.mock("@/lib/localDb.js", () => ({ updateProviderConnection: vi.fn(async () => ({})), getProviderConnectionById: vi.fn(), getProviderConnections: vi.fn(() => Promise.resolve([])) }));
    vi.doMock("open-sse/services/oauthCredentialManager.js", async () => {
      const actual = await vi.importActual("open-sse/services/oauthCredentialManager.js");
      return { ...actual, refreshProviderCredentials: vi.fn(), shouldRefreshCredentials: actual.shouldRefreshCredentials };
    });
    vi.doMock("open-sse/services/projectId.js", async () => {
      const actual = await vi.importActual("open-sse/services/projectId.js");
      return { ...actual, getProjectIdForConnection: async () => null, invalidateProjectId: () => {}, removeConnection: () => {} };
    });
    global.BroadcastChannel = global.BroadcastChannel || class { constructor(){ } postMessage(){} close(){} };
    wrapper = await import("../../src/sse/services/tokenRefresh.js");
    wrapper.resetUnrecoverableRefreshFailuresForTests();
    const { updateProviderConnection } = await import("../../src/lib/localDb.js");
    updateSpy = updateProviderConnection;
    chatCore = await import("../../open-sse/handlers/chatCore.js");
    executeMock.mockReset();
    refreshMock.mockReset();
  });

  afterEach(() => { vi.unstubAllEnvs?.(); vi.resetModules(); });

  function makeOptions() {
    return {
      body: { model: "codex", stream: false, messages: [{ role: "user", content: "hi" }] }, modelInfo: { provider: "codex", model: "codex" },
      credentials: { apiKey: "k", connectionId: "conn-401", refreshToken: "rt", providerSpecificData: {} },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), line: vi.fn(), errorLine: vi.fn(), tagForSession: vi.fn() }, connectionId: "conn-401",
      clientRawRequest: { endpoint: "/v1/chat/completions", body: {}, headers: { accept: "application/json" } },
      onCredentialsRefreshed: async (newCreds) => {
        if (newCreds.__terminalRefreshFailure) await wrapper.recordUnrecoverableRefreshFailure("conn-401", newCreds.__terminalRefreshFailure);
      },
    };
  }

  it("persists marker on second reactive 401 and does not re-execute upstream", async () => {
    refreshMock.mockResolvedValue({ error: "unrecoverable_refresh_error", code: "refresh_token_invalidated" });
    executeMock.mockResolvedValue({ response: new Response("{\"error\":\"invalid\"}", { status: 401, headers: { "content-type": "application/json" } }), url: "https://auth.openai.com/oauth/token", headers: {}, transformedBody: null });

    expect((await chatCore.handleChatCore(makeOptions())).status).toBe(401);
    expect(updateSpy).not.toHaveBeenCalledWith("conn-401", expect.objectContaining({ lastErrorType: "token_refresh_failed" }));
    expect((await chatCore.handleChatCore(makeOptions())).status).toBe(401);
    expect(updateSpy).toHaveBeenCalledWith("conn-401", expect.objectContaining({ lastErrorType: "token_refresh_failed" }));
    expect(updateSpy.mock.calls.at(-1)[1].reauthRequiredAt).toBeTruthy();
    expect(executeMock).toHaveBeenCalledTimes(2);
  });
});
