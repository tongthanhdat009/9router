// ZCode JWT renewal chain: refreshProviderCredentials("zcode") MUST merge a
// JWT-shaped data.token (and a minted coding-plan key) into providerSpecificData
// so the next inference reuses it; and chatCore maps a permanent refresh failure
// to an actionable re-login message (muse-pattern slot).
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));
vi.mock("../../src/lib/oauth/services/zcode.js", () => ({ refreshZcodeToken: vi.fn() }));

const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
const { refreshZcodeToken } = await import("../../src/lib/oauth/services/zcode.js");
const { refreshProviderCredentials } = await import("../../open-sse/services/oauthCredentialManager.js");

beforeEach(() => { vi.clearAllMocks(); });

describe("zcode JWT renewal via generic refresh chain", () => {
  it("JWT-shaped data.token lands in providerSpecificData.zcodeJwtToken after merge", async () => {
    vi.mocked(refreshZcodeToken).mockResolvedValue({
      accessToken: "new-access",
      expiresIn: 3600,
      providerSpecificData: { zcodeJwtToken: "aaa.bbb.ccc", codingPlanApiKey: "df8d-minted.key" },
    });
    const merged = await refreshProviderCredentials("zcode", {
      connectionId: "jt-1",
      accessToken: "old-access",
      refreshToken: "rt-1",
      providerSpecificData: { zcodeJwtToken: "stale.jwt", deviceId: "d1" },
    });
    expect(merged.accessToken).toBe("new-access");
    expect(merged.providerSpecificData.zcodeJwtToken).toBe("aaa.bbb.ccc");
    expect(merged.providerSpecificData.codingPlanApiKey).toBe("df8d-minted.key");
    expect(merged.providerSpecificData.deviceId).toBe("d1"); // unrelated PSD preserved
  });

  it("refresh WITHOUT a JWT keeps expiry tracked on accessToken (JWT renewal is opportunistic)", async () => {
    vi.mocked(refreshZcodeToken).mockResolvedValue({ accessToken: "acc-2", expiresIn: 7200 });
    const merged = await refreshProviderCredentials("zcode", {
      connectionId: "jt-2",
      refreshToken: "rt-2",
      providerSpecificData: { zcodeJwtToken: "still-old.jwt" },
    });
    expect(merged.accessToken).toBe("acc-2");
    expect(Date.parse(merged.expiresAt)).toBeGreaterThan(Date.now());
    // No PSD in refresh result => request-scoped merge carries none; the stored
    // connection keeps its existing zcodeJwtToken (store-merge is a separate step).
    expect(merged.providerSpecificData).toBeUndefined();
  });

  it("chatCore maps a permanent zcode refresh failure to an actionable re-login 401", async () => {
    vi.mocked(refreshZcodeToken).mockResolvedValue({ error: "invalid_grant" });
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    let refreshCalls = 0;
    const { proxyAwareFetch: paf } = await import("../../open-sse/utils/proxyFetch.js");
    paf.mockImplementation(async (url, options = {}) => {
      if (String(url).includes("/api/auth/z/login")) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ code: 0, data: { access_token: "biz" } }) };
      if (String(url).includes("getCustomerInfo")) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ code: 0, data: { organizations: [{ organizationId: "o", projects: [{ projectId: "p" }] }] } }) };
      if (String(url).includes("/api_keys")) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ code: 0, data: [{ name: "zcode-api-key", apiKey: "k1" }] }) };
      if (String(url).includes("/api_keys/copy/")) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ code: 0, data: { secretKey: "s1" } }) };
      if (String(url).includes("/v1/messages")) {
        return { ok: false, status: 401, headers: { get: () => null }, json: async () => ({ error: { message: "upstream says no" } }), text: async () => "upstream says no", clone() { return this; } };
      }
      throw new Error("jwt-test unexpected " + url);
    });
    const { response } = await handleChatCore({
      body: { model: "GLM-5.3", messages: [{ role: "user", content: "hi" }], stream: false, max_tokens: 16 },
      modelInfo: { provider: "zcode", model: "GLM-5.3" },
      credentials: { connectionId: "jt-3", accessToken: "a", refreshToken: "r", providerSpecificData: { zcodeJwtToken: "dead.jwt" } },
      log: console,
      connectionId: "jt-3",
      apiKey: null,
      userAgent: "vitest",
      onCredentialsRefreshed: async () => { refreshCalls += 1; },
    });
    const text = await response.text();
    expect(response.status).toBe(401);
    expect(text).toContain("Re-login via device flow");
    expect(text).toContain("zcode");
  });

  it("refresh OK without renewed JWT, stale JWT 401s again: bounded retries then actionable re-auth", async () => {
    // Upstream contract boundary: refresh returns a fresh accessToken but NO
    // JWT-shaped data.token, so the off-peak channel keeps consuming the dead JWT.
    vi.mocked(refreshZcodeToken).mockResolvedValue({ accessToken: "acc-fresh", expiresIn: 3600 });
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    const { proxyAwareFetch: paf } = await import("../../open-sse/utils/proxyFetch.js");
    let inferenceCalls = 0;
    let ticketCalls = [];
    paf.mockImplementation(async (url, options = {}) => {
      if (String(url).includes("/v1/off-peak/anthropic/v1/messages")) {
        inferenceCalls += 1;
        return { ok: false, status: 401, headers: { get: () => null }, json: async () => ({ code: 4001, msg: "expired jwt" }), text: async () => "expired jwt", clone() { return this; } };
      }
      if (String(url).includes("/zcode-plan/billing/balance")) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ code: 0, data: { configs: { offPeak: { enable_offpeak_task: true, allowed_models: ["GLM-5.3"] } } } }), text: async () => "{}" };
      if (String(url).includes("/ticket/availability")) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ code: 0, data: { can_take_number: true } }), text: async () => "{}" };
      if (String(url).includes("/ticket") && options.method === "POST") {
        if (String(url).includes("/ticket/status")) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ code: 0, data: { tickets: [{ ticket_id: "tk-stale", state: "active" }], next_poll_after: 0 } }), text: async () => "{}" };
        if (String(url).includes("/settle")) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ code: 0, data: {} }), text: async () => "{}" };
        ticketCalls.push("take");
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ code: 0, data: { ticket_id: "tk-stale", state: "active" } }), text: async () => "{}" };
      }
      if (String(url).includes("/api_keys/copy/")) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ code: 0, data: { secretKey: "s1" } }), text: async () => "{}" };
      if (String(url).includes("/api_keys")) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ code: 0, data: [{ name: "zcode-api-key", apiKey: "k1" }] }), text: async () => "{}" };
      if (String(url).includes("getCustomerInfo")) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ code: 0, data: { organizations: [{ organizationId: "o", projects: [{ projectId: "p" }] }] } }), text: async () => "{}" };
      if (String(url).includes("/api/auth/z/login")) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ code: 0, data: { access_token: "biz" } }), text: async () => "{}" };
      if (String(url).includes("/v1/ultra-zai/anthropic/v1/messages")) {
        inferenceCalls += 1;
        return { ok: false, status: 401, headers: { get: () => null }, json: async () => ({ error: { message: "still unauthorized" } }), text: async () => "still unauthorized", clone() { return this; } };
      }
      if (String(url).includes("/v1/oauth/token") || String(url).includes("/oauth/token")) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ access_token: "acc-fresh", expires_in: 3600 }), text: async () => "{}" };
      throw new Error("stale-jwt unexpected " + url);
    });
    const { response } = await handleChatCore({
      body: { model: "GLM-5.3", messages: [{ role: "user", content: "hi" }], stream: false, max_tokens: 16 },
      modelInfo: { provider: "zcode", model: "GLM-5.3" },
      credentials: {
        connectionId: "jt-4", accessToken: "stale", refreshToken: "rt-4",
        // Active cached ticket forces the off-peak channel, which consumes the dead JWT.
        providerSpecificData: { zcodeJwtToken: "dead.jwt.no-renewal", deviceId: "d4", codingPlanApiKey: "df8d-k1.s1" },
      },
      log: console,
      connectionId: "jt-4",
      apiKey: null,
      userAgent: "vitest",
      onCredentialsRefreshed: async () => {},
    });
    const text = await response.text();
    expect(response.status).toBe(401);
    // Exactly 6 upstream inference attempts, all bounded: executor does 2 off-peak
    // + 1 normal per round; chatCore allows exactly ONE post-refresh retry round.
    expect(inferenceCalls).toBe(6);
    // Ticket was taken once (shared across the bounded rounds).
    expect(ticketCalls.filter((m) => m === "take")).toHaveLength(1);
    // Actionable re-auth, not the raw "expired jwt" body.
    expect(text).toContain("refresh did not restore access");
    expect(text).toContain("zcode");
    expect(text).not.toContain("expired jwt");
  });
});


