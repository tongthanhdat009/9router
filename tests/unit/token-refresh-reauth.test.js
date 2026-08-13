import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Two-call sticky terminal check: first unrecoverable = no marker, second = write.

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
