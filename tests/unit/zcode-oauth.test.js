import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("open-sse/services/zcodeKey.js", () => ({
  mintCodingPlanKey: vi.fn(async () => ({ key: "df8d-minted-key.secret123" })),
}));

import zcode from "../../src/lib/oauth/providers/zcode.js";

const INIT = "https://zcode.z.ai/api/v1/oauth/cli/init";
const POLL_BASE = "https://zcode.z.ai/api/v1/oauth/cli/poll/";
const originalFetch = global.fetch;

function okJson(payload) {
  return { ok: true, status: 200, json: () => Promise.resolve(payload) };
}

describe("zcode oauth adapter", () => {
  beforeEach(() => { vi.clearAllMocks(); global.fetch = originalFetch; });
  afterEach(() => { global.fetch = originalFetch; });

  it("declares the shared device-code adapter contract", () => {
    expect(zcode.flowType).toBe("device_code");
    expect(zcode.config).toEqual({});
  });

  it("posts device init with Bearer poll_token and maps flow fields", async () => {
    const fetchMock = vi.fn(async (url, options) => {
      expect(url).toBe(INIT);
      expect(options.method).toBe("POST");
      const bearer = options.headers.Authorization || options.headers.authorization;
      expect(bearer).toMatch(/^Bearer [0-9a-f]{64}$/);
      expect(JSON.parse(options.body)).toEqual({ provider: "zai" });
      return okJson({ code: 0, data: { flow_id: "flow-1", authorize_url: "https://z.ai/x", expires_at: Math.floor(Date.now() / 1000) + 300 } });
    });
    global.fetch = fetchMock;
    const data = await zcode.requestDeviceCode();
    expect(data.device_code).toBe("flow-1");
    expect(data.verification_uri).toBe("https://z.ai/x");
    expect(data.interval).toBe(2);
    expect(data._zcodePollToken).toMatch(/^[0-9a-f]{64}$/);
  });

  it("maps pending to authorization_pending", async () => {
    global.fetch = vi.fn(async () => okJson({ code: 0, data: { status: "pending" } }));
    const result = await zcode.pollToken({}, "flow-1", null, { _zcodePollToken: "p".repeat(64) });
    expect(result).toEqual({ ok: true, data: { error: "authorization_pending" } });
  });

  it("passes the shared success gate and mapTokens persists JWT PSD", async () => {
    const poll = vi.fn(async () => okJson({
      code: 0,
      data: { status: "ready", token: "jwt-1", user: { email: "a@b.c", user_id: "u-1" }, zai: { access_token: "zai-at", refresh_token: "zai-rt", expires_at: Math.floor(Date.now() / 1000) + 3600 } },
    }));
    global.fetch = poll;
    const result = await zcode.pollToken({}, "flow-1", null, { _zcodePollToken: "p".repeat(64) });
    expect(result.ok).toBe(true);
    expect(result.data.access_token).toBe("zai-at");
    const extra = await zcode.postExchange(result.data);
    const tokens = zcode.mapTokens(result.data, extra);
    expect(tokens.accessToken).toBe("zai-at");
    expect(tokens.refreshToken).toBe("zai-rt");
    expect(tokens.providerSpecificData.zcodeJwtToken).toBe("jwt-1");
    expect(tokens.providerSpecificData.deviceId).toBeTruthy();
    expect(poll.mock.calls[0][0]).toBe(POLL_BASE + "flow-1");
  });

  it("postExchange immediately mints codingPlanApiKey and maps into PSD", async () => {
    const payload = { access_token: "tok-fresh" };
    const extra = await zcode.postExchange(payload);
    expect(extra).toEqual({ codingPlanApiKey: "df8d-minted-key.secret123" });
    const tokens = zcode.mapTokens({ token: "jwt-test", user: { user_id: "u1" }, zai: payload }, extra);
    expect(tokens.providerSpecificData.codingPlanApiKey).toBe("df8d-minted-key.secret123");
  });

  it("registers the four device-flow gates", () => {
    const route = readFileSync(resolve("../src/app/api/oauth/[provider]/[action]/route.js"), "utf8");
    expect(route).toContain('"zcode"');
    const modal = readFileSync(resolve("../src/shared/components/OAuthModal.js"), "utf8");
    expect(modal).toContain('"zcode"');
    expect(modal).toContain("_zcodePollToken");
  });
});
