import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { mintCodingPlanKey, ensureCodingPlanKey, clearZcodeKeyStateForTests } from "../../open-sse/services/zcodeKey.js";

const LOGIN = "https://api.z.ai/api/auth/z/login";
const CUSTOMER = "https://api.z.ai/api/biz/customer/getCustomerInfo";
const ORG = "org-1";
const PROJ = "proj-1";
const KEYS = "https://api.z.ai/api/biz/v1/organization/org-1/projects/proj-1/api_keys";

function creds(extra) {
  return { connectionId: "conn-1", ...(extra ? extra : {}) };
}
function okJson(payload) {
  return { ok: true, status: 200, json: () => Promise.resolve(payload) };
}
// Mock the observed 4-step flow: login -> customer -> api_keys list -> copy.
function flowMock({ login, customer, keys, copy, postCreate } = {}) {
  let created = false;
  return async (url, options) => {
    options = options || {};
    if (url === LOGIN) {
      if (login) return login(options);
      return okJson({ code: 200, data: { access_token: "biz-1" } });
    }
    if (url === CUSTOMER) {
      if (customer) return customer(options);
      return okJson({ code: 200, data: { organizations: [{ organizationId: ORG, projects: [{ projectId: PROJ }] }] } });
    }
    if (url === KEYS) {
      if (keys) return keys(options, created);
      if (options.method === "POST") {
        created = true;
        if (postCreate) return postCreate(options);
        return okJson({ code: 200, data: { name: "zcode-api-key", apiKey: "df8dnewkey000000000000000000000001" } });
      }
      return okJson({ code: 200, data: [{ name: "zcode-api-key", apiKey: "df8dabcdef1234567890abcdef12345678" }] });
    }
    if (String(url).startsWith(KEYS + "/copy/")) {
      if (copy) return copy(options);
      return okJson({ code: 200, data: { secretKey: "sec1234567890abcd" } });
    }
    throw new Error("unexpected " + url);
  };
}

describe("zcodeKey module", () => {
  beforeEach(() => {
    clearZcodeKeyStateForTests();
    vi.mocked(proxyAwareFetch).mockReset();
  });

  it("mints apiKey.secretKey via the observed login/customer/api_keys/copy flow", async () => {
    const calls = [];
    vi.mocked(proxyAwareFetch).mockImplementation(flowMock({
      login: (options) => {
        calls.push(["login", JSON.parse(options.body).token]);
        return okJson({ code: 200, data: { access_token: "biz-1" } });
      },
      customer: (options) => {
        calls.push(["customer", options.headers.Authorization]);
        return okJson({ code: 200, data: { organizations: [{ organizationId: ORG, projects: [{ projectId: PROJ }] }] } });
      },
    }));
    const out = await mintCodingPlanKey(creds({ accessToken: "oauth-tok-1" }));
    expect(out.key).toBe("df8dabcdef1234567890abcdef12345678.sec1234567890abcd");
    expect(out.source).toBe("mint");
    expect(out.entitlement.path).toBe("api_keys/zcode-api-key+copy");
    expect(calls[0]).toEqual(["login", "oauth-tok-1"]);
    expect(calls[1][1]).toBe("Bearer biz-1");
  });

  it("creates the named key when absent", async () => {
    vi.mocked(proxyAwareFetch).mockImplementation(flowMock({
      keys: (options, created) => {
        if (!created && options.method !== "POST") return okJson({ code: 200, data: [{ name: "other", apiKey: "df8dother" }] });
        if (options.method === "POST") return okJson({ code: 200, data: { name: "zcode-api-key", apiKey: "df8dcreated000000000000000000001" } });
        return okJson({ code: 200, data: [{ name: "zcode-api-key", apiKey: "df8dcreated000000000000000000001" }] });
      },
    }));
    const out = await mintCodingPlanKey(creds({ accessToken: "oauth-tok-1" }));
    expect(out.key.startsWith("df8dcreated")).toBe(true);
    expect(out.key.includes(".")).toBe(true);
  });

  it("concurrent ensure shares one in-flight mint (single login)", async () => {
    let logins = 0;
    vi.mocked(proxyAwareFetch).mockImplementation(flowMock({
      login: () => {
        logins += 1;
        return okJson({ code: 200, data: { access_token: "biz-1" } });
      },
    }));
    const c = creds({ accessToken: "tok-1" });
    const [a, b] = await Promise.all([ensureCodingPlanKey(c), ensureCodingPlanKey(c)]);
    expect(a).toBe(b);
    expect(logins).toBe(1);
  });

  it("logical 401 in login is AUTH (non-retryable), not missing-plan", async () => {
    vi.mocked(proxyAwareFetch).mockImplementation(flowMock({
      login: () => okJson({ code: 401, msg: "token expired or incorrect", success: false }),
    }));
    await expect(mintCodingPlanKey(creds({ accessToken: "tok-1" }))).rejects.toMatchObject({ code: "coding_plan_auth_failed", status: 401 });
  });

  it("customer-info logical 401 maps to auth failure", async () => {
    vi.mocked(proxyAwareFetch).mockImplementation(flowMock({
      customer: () => okJson({ code: 401, msg: "token expired or incorrect", success: false }),
    }));
    await expect(mintCodingPlanKey(creds({ accessToken: "tok-1" }))).rejects.toMatchObject({ code: "coding_plan_auth_failed" });
  });

  it("no org/project resolves to coding_plan_not_connected", async () => {
    vi.mocked(proxyAwareFetch).mockImplementation(flowMock({
      customer: () => okJson({ code: 200, data: { organizations: [] } }),
    }));
    await expect(mintCodingPlanKey(creds({ accessToken: "tok-1" }))).rejects.toMatchObject({ code: "coding_plan_not_connected" });
  });

  it("copy missing secretKey falls back to bare apiKey", async () => {
    vi.mocked(proxyAwareFetch).mockImplementation(flowMock({
      copy: () => okJson({ code: 200, data: {} }),
    }));
    const out = await mintCodingPlanKey(creds({ accessToken: "tok-1" }));
    expect(out.key).toBe("df8dabcdef1234567890abcdef12345678");
    expect(out.entitlement.path).toBe("api_keys/zcode-api-key");
  });

  it("no access token fails closed", async () => {
    await expect(mintCodingPlanKey(creds({}))).rejects.toMatchObject({ code: "coding_plan_auth_failed", status: 401 });
  });

  it("redaction: logs carry path only, never key value", async () => {
    const logs = [];
    const orig = console.log;
    console.log = (...a) => { logs.push(a.join(" ")); };
    vi.mocked(proxyAwareFetch).mockImplementation(flowMock({}));
    await mintCodingPlanKey(creds({ accessToken: "tok-1" }));
    console.log = orig;
    const joined = logs.join("\n");
    expect(joined).toContain("[DBG:ZCODEKEY]");
    expect(joined).toContain("path=");
    expect(joined.includes("df8dabcdef1234567890abcdef12345678")).toBe(false);
  });
});
