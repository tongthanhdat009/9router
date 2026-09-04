import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getZcodeUsage } from "../../open-sse/services/usage/zcode.js";

function res(payload, status) {
  return { ok: (status || 200) < 400, status: status || 200, headers: { get: () => null }, json: () => Promise.resolve(payload) };
}
const CREDS = { connectionId: "c1", providerSpecificData: { zcodeJwtToken: "jwt-1", codingPlanApiKey: "df8dkey.secret" } };

describe("zcode usage", () => {
  beforeEach(() => { vi.mocked(proxyAwareFetch).mockReset(); });
  afterEach(() => { vi.mocked(proxyAwareFetch).mockReset(); });

  it("E7 usage maps balance fields", async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValue(res({ code: 0, data: { grant_units: 100, used_units: 30, remaining_units: 70, total_units: 100, expires_at: 1700000000 } }));
    const usage = await getZcodeUsage(CREDS, null, {});
    expect(usage.quotas["Coding plan"]).toMatchObject({ used: 30, total: 100, remaining: 70, unlimited: false });
    expect(usage.quotas["Coding plan"].resetAt).toBeTruthy();
    const [url, options] = vi.mocked(proxyAwareFetch).mock.calls[0];
    expect(url).toBe("https://zcode.z.ai/api/v1/zcode-plan/billing/balance");
    expect(options.headers.Authorization).toBe("Bearer jwt-1");
    expect(options.headers["X-Coding-Plan-Api-Key"]).toBe("df8dkey.secret");
    expect(options.headers["User-Agent"]).toBe("ZCode/3.10.2.6414");
    expect(options.headers["X-ZCode-Agent"]).toBe("glm");
    expect(typeof options.headers["X-Request-Id"]).toBe("string");
    expect(typeof options.headers["X-Session-Id"]).toBe("string");
  });

  it("falls back to derived totals when grant/remaining missing", async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValue(res({ code: 0, data: { total_units: 50, used_units: 10 } }));
    const usage = await getZcodeUsage(CREDS, null, {});
    expect(usage.quotas["Coding plan"]).toMatchObject({ used: 10, total: 50, remaining: 40 });
  });

  it("lazy-mints a missing stored key before billing", async () => {
    const c = { connectionId: "c-mint", accessToken: "oauth-1", providerSpecificData: { zcodeJwtToken: "jwt-1" } };
    const base = "https://api.z.ai/api/biz/v1/organization/o1/projects/p1/api_keys";
    vi.mocked(proxyAwareFetch).mockImplementation(async (url) => {
      if (url === "https://api.z.ai/api/auth/z/login") return res({ code: 200, data: { access_token: "biz-1" } });
      if (url === "https://api.z.ai/api/biz/customer/getCustomerInfo") return res({ code: 200, data: { organizations: [{ organizationId: "o1", projects: [{ projectId: "p1" }] }] } });
      if (url === base) return res({ code: 200, data: [{ name: "zcode-api-key", apiKey: "df8dminted000000000000000000001" }] });
      if (String(url).startsWith(base + "/copy/")) return res({ code: 200, data: { secretKey: "sec0000000000001" } });
      if (url === "https://zcode.z.ai/api/v1/zcode-plan/billing/balance") return res({ code: 0, data: { total_units: 10, used_units: 1 } });
      throw new Error("unexpected " + url);
    });
    const usage = await getZcodeUsage(c, null, {});
    expect(usage.quotas["Coding plan"].remaining).toBe(9);
    const billing = vi.mocked(proxyAwareFetch).mock.calls.find(([url]) => url === "https://zcode.z.ai/api/v1/zcode-plan/billing/balance");
    expect(billing[1].headers["X-Coding-Plan-Api-Key"]).toContain(".");
  });

  it("missing JWT/key and 401 return messages without throwing", async () => {
    const noJwt = await getZcodeUsage({ connectionId: "c2", providerSpecificData: {} }, null, {});
    expect(typeof noJwt.message).toBe("string");
    const noKey = await getZcodeUsage({ connectionId: "c3", providerSpecificData: { zcodeJwtToken: "jwt-1" } }, null, {});
    expect(noKey.message).toContain("coding-plan key");
    vi.mocked(proxyAwareFetch).mockResolvedValue(res({}, 401));
    const unauth = await getZcodeUsage(CREDS, null, {});
    expect(typeof unauth.message).toBe("string");
  });
});
