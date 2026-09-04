import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getZcodeUsage } from "../../open-sse/services/usage/zcode.js";

function res(payload, status) {
  return { ok: (status || 200) < 400, status: status || 200, headers: { get: () => null }, json: () => Promise.resolve(payload) };
}
const CREDS = { connectionId: "c1", providerSpecificData: { zcodeJwtToken: "jwt-1" } };

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
  });

  it("falls back to derived totals when grant/remaining missing", async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValue(res({ code: 0, data: { total_units: 50, used_units: 10 } }));
    const usage = await getZcodeUsage(CREDS, null, {});
    expect(usage.quotas["Coding plan"]).toMatchObject({ used: 10, total: 50, remaining: 40 });
  });

  it("missing JWT and 401 return messages without throwing", async () => {
    const noJwt = await getZcodeUsage({ connectionId: "c2", providerSpecificData: {} }, null, {});
    expect(typeof noJwt.message).toBe("string");
    vi.mocked(proxyAwareFetch).mockResolvedValue(res({}, 401));
    const unauth = await getZcodeUsage(CREDS, null, {});
    expect(typeof unauth.message).toBe("string");
  });
});
