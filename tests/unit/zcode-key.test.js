import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { mintCodingPlanKey, ensureCodingPlanKey, clearZcodeKeyStateForTests } from "../../open-sse/services/zcodeKey.js";

const URL_ = "https://api.z.ai/api/biz/customer/getCustomerInfo";

function creds(extra) {
  return { connectionId: "conn-1", ...(extra ? extra : {}) };
}
function okInfo(payload) {
  return { ok: true, status: 200, json: () => Promise.resolve(payload) };
}

describe("zcodeKey module", () => {
  beforeEach(() => { clearZcodeKeyStateForTests(); vi.mocked(proxyAwareFetch).mockReset(); });
  afterEach(() => { vi.mocked(proxyAwareFetch).mockReset(); });

  it("mints from nested candidate path with RAW access_token (no Bearer)", async () => {
    vi.mocked(proxyAwareFetch).mockImplementation(async (url, options) => {
      expect(url).toBe(URL_);
      expect(options.headers.Authorization).toBe("tok-1");
      expect(options.headers.Authorization.startsWith("Bearer ")).toBe(false);
      return okInfo({ code: 0, data: { coding_plan_api_key: "df8dabcdef1234567890" } });
    });
    const out = await mintCodingPlanKey(creds({ accessToken: "tok-1" }));
    expect(out.key).toBe("df8dabcdef1234567890");
    expect(out.source).toBe("mint");
    expect(out.entitlement.path).toBe("data.coding_plan_api_key");
  });

  it("returns cached paste key without network", async () => {
    const key = await ensureCodingPlanKey(creds({ providerSpecificData: { codingPlanApiKey: "df8dpaste000000001" } }));
    expect(key).toBe("df8dpaste000000001");
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("concurrent ensure shares one in-flight mint (single GET)", async () => {
    let calls = 0;
    vi.mocked(proxyAwareFetch).mockImplementation(async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return okInfo({ code: 0, data: { codingPlanApiKey: "df8dshared000000001" } });
    });
    const c = creds({ accessToken: "tok-1" });
    const [a, b, c2] = await Promise.all([ensureCodingPlanKey(c), ensureCodingPlanKey(c), ensureCodingPlanKey(c)]);
    expect(a).toBe("df8dshared000000001");
    expect(b).toBe(a);
    expect(c2).toBe(a);
    expect(calls).toBe(1);
  });

  it("auth failure maps coding_plan_auth_failed non-retryable", async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValue({ ok: false, status: 401, json: () => Promise.resolve({}) });
    await expect(mintCodingPlanKey(creds({ accessToken: "tok-1" }))).rejects.toMatchObject({ code: "coding_plan_auth_failed", retryable: false });
  });

  it("no key in body maps coding_plan_not_entitled", async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValue(okInfo({ code: 0, data: { plan: "none", message: "user has no coding plan subscription" } }));
    await expect(mintCodingPlanKey(creds({ accessToken: "tok-1" }))).rejects.toMatchObject({ code: "coding_plan_not_entitled" });
  });

  it("not_connected body maps coding_plan_not_connected", async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValue(okInfo({ code: 0, data: { message: "account not connected to coding plan" } }));
    await expect(mintCodingPlanKey(creds({ accessToken: "tok-1" }))).rejects.toMatchObject({ code: "coding_plan_not_connected" });
  });

  it("5xx maps retryable", async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValue({ ok: false, status: 503, json: () => Promise.resolve({}) });
    await expect(mintCodingPlanKey(creds({ accessToken: "tok-1" }))).rejects.toMatchObject({ retryable: true });
  });

  it("missing access token fails closed with auth_failed", async () => {
    await expect(mintCodingPlanKey(creds({}))).rejects.toMatchObject({ code: "coding_plan_auth_failed" });
  });

  it("redaction: logs carry path only, never key value", async () => {
    const logs = [];
    const orig = console.log;
    console.log = (...a) => { logs.push(a.join(" ")); };
    vi.mocked(proxyAwareFetch).mockResolvedValue(okInfo({ code: 0, data: { codingPlanApiKey: "df8dsecretvalue00001" } }));
    await mintCodingPlanKey(creds({ accessToken: "tok-1" }));
    console.log = orig;
    const joined = logs.join("\n");
    expect(joined).toContain("[DBG:ZCODEKEY]");
    expect(joined).toContain("path=");
    expect(joined.includes("df8dsecretvalue00001")).toBe(false);
  });
});
