import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));

const { ZcodeExecutor } = await import("../../open-sse/executors/zcode.js");
const { clearZcodeOffpeakStateForTests } = await import("../../open-sse/services/offpeak/zcode.js");

const BALANCE = "https://zcode.z.ai/api/v1/zcode-plan/billing/balance";
const AVAIL = "https://zcode.z.ai/api/v1/off-peak/ticket/availability";
const TAKE = "https://zcode.z.ai/api/v1/off-peak/ticket";
const STATUS = "https://zcode.z.ai/api/v1/off-peak/ticket/status";

function res(payload, status) {
  return { ok: (status || 200) < 400, status: status || 200, headers: { get: () => null }, json: () => Promise.resolve(payload), text: () => Promise.resolve(JSON.stringify(payload)) };
}
function openWindow() {
  return async (url, options) => {
    options = options || {};
    if (url === BALANCE) return res({ code: 0, data: { configs: { offPeak: { enable_offpeak_task: true, allowed_models: ["glm-5.3-flash"] } } } });
    if (url === AVAIL) return res({ code: 0, data: { can_take_number: true } });
    if (url === TAKE && options.method === "POST") return res({ code: 0, data: { ticket_id: "tk-e1", status: "active" } });
    if (url === STATUS) return res({ code: 0, data: { status: "active", next_poll_after: 0 } });
    throw new Error("unexpected " + url);
  };
}
function closedWindow() {
  return async (url) => {
    if (url === BALANCE) return res({ code: 0, data: { configs: { offPeak: { enable_offpeak_task: true, allowed_models: ["glm-5.3-flash"] } } } });
    if (url === AVAIL) return res({ code: 0, data: { can_take_number: false, next_take_at: Math.floor(Date.now() / 1000) + 3600 } });
    throw new Error("unexpected " + url);
  };
}
function baseCreds(id) {
  return { connectionId: id || "c-exec", rawHeaders: {}, providerSpecificData: { zcodeJwtToken: "jwt-1", codingPlanApiKey: "key-1", deviceId: "dev-1", userId: "u-1" } };
}
function okUpstream() {
  return { response: { ok: true, status: 200 }, url: "https://api.z.ai/api/anthropic/v1/messages", headers: {}, transformedBody: {} };
}

describe("zcode executor", () => {
  beforeEach(() => { clearZcodeOffpeakStateForTests(); });

  it("static identity set + stable session + per-call UUIDs + user_id inject", async () => {
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    vi.mocked(proxyAwareFetch).mockImplementation(openWindow());
    const executor = new ZcodeExecutor();
    const credentials = baseCreds();
    const spy = vi.spyOn(executor, "buildHeaders");
    const superExecute = vi.spyOn(Object.getPrototypeOf(ZcodeExecutor.prototype), "execute").mockResolvedValue(okUpstream());
    await executor.execute({ model: "glm-5.3-flash", body: { model: "glm-5.3-flash", messages: [] }, stream: false, credentials, log: console });
    const headers = executor.buildHeaders(credentials, false, null, null, {});
    expect(headers["User-Agent"]).toBe("ZCode/3.10.2.6414");
    expect(headers["X-ZCode-Agent"]).toBe("glm");
    expect(headers["X-Session-Id"]).toBe(credentials.__zcodeChannel.sessionId);
    expect(new Set([headers["X-Request-Id"], headers["X-Query-Id"], headers["X-ZCode-Trace-Id"]]).size).toBe(3);
    const body = { metadata: {} };
    executor.transformRequest("glm-5.3-flash", body, false, credentials);
    const parsed = JSON.parse(body.metadata.user_id);
    expect(parsed.device_id).toBe("dev-1");
    expect(parsed.session_id).toBe(credentials.__zcodeChannel.sessionId);
    superExecute.mockRestore();
    spy.mockRestore();
  });

  it("E1 eligible+open routes offpeak with ticket headers", async () => {
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    vi.mocked(proxyAwareFetch).mockImplementation(openWindow());
    const executor = new ZcodeExecutor();
    const credentials = baseCreds();
    let captured;
    const superExecute = vi.spyOn(Object.getPrototypeOf(ZcodeExecutor.prototype), "execute").mockImplementation(async (args) => { captured = executor.buildHeaders(args.credentials, false, null, null, {}); return okUpstream(); });
    await executor.execute({ model: "glm-5.3-flash", body: { model: "glm-5.3-flash", messages: [] }, stream: false, credentials, log: console });
    expect(credentials.__zcodeChannel.channel).toBe("offpeak");
    expect(credentials.__zcodeChannel.ticketId).toBe("tk-e1");
    expect(captured["X-Off-Peak-Ticket-ID"]).toBe("tk-e1");
    expect(captured["Authorization"]).toBe("Bearer jwt-1");
    expect(executor.buildUrl("glm-5.3-flash", false, 0, credentials)).toBe("https://zcode.z.ai/api/v1/off-peak/anthropic/v1/messages");
    superExecute.mockRestore();
  });

  it("E2 closed window routes normal with dual key headers", async () => {
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    vi.mocked(proxyAwareFetch).mockImplementation(closedWindow());
    const executor = new ZcodeExecutor();
    const credentials = baseCreds();
    const superExecute = vi.spyOn(Object.getPrototypeOf(ZcodeExecutor.prototype), "execute").mockResolvedValue(okUpstream());
    await executor.execute({ model: "glm-5.3-flash", body: { model: "glm-5.3-flash", messages: [] }, stream: false, credentials, log: console });
    expect(credentials.__zcodeChannel.channel).toBe("normal");
    expect(executor.buildUrl("m", false, 0, credentials)).toBe("https://api.z.ai/api/anthropic/v1/messages");
    const headers = executor.buildHeaders(credentials, false, null, null, {});
    expect(headers["x-api-key"]).toBe("key-1");
    expect(headers["Authorization"]).toBe("Bearer key-1");
    superExecute.mockRestore();
  });

  function liveResponse(payload, status, retryAfter) {
    const body = JSON.stringify(payload);
    const response = new Response(body, { status, headers: { "content-type": "application/json", ...(retryAfter ? { "retry-after": String(retryAfter) } : {}) } });
    return { response, url: "https://zcode.z.ai/api/v1/off-peak/anthropic/v1/messages", headers: {}, transformedBody: {} };
  }

  it("E3 inference 3105 retries same ticket then normal re-dispatch", async () => {
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    vi.mocked(proxyAwareFetch).mockImplementation(openWindow());
    const executor = new ZcodeExecutor();
    const credentials = baseCreds();
    const calls = [];
    const superExecute = vi.spyOn(Object.getPrototypeOf(ZcodeExecutor.prototype), "execute").mockImplementation(async () => { calls.push(credentials.__zcodeChannel.ticketId); return calls.length < 3 ? liveResponse({ code: 3105, message: "ticket not ready" }, 429, 1) : okUpstream(); });
    vi.spyOn(executor, "dispatchNormal").mockImplementation(async (args) => { credentials.__zcodeChannel.channel = "normal"; credentials.__zcodeChannel.ticketId = null; return okUpstream(); });
    await executor.execute({ model: "glm-5.3-flash", body: { model: "glm-5.3-flash", messages: [] }, stream: false, credentials, log: console });
    expect(calls[0]).toBe("tk-e1");
    expect(calls[1]).toBe("tk-e1");
    expect(credentials.__zcodeChannel.recovered).toBe(true);
    superExecute.mockRestore();
  });

  it("E4 inference 3102 retakes and retries then normal re-dispatch", async () => {
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    let takes = 0;
    vi.mocked(proxyAwareFetch).mockImplementation(async (url, options) => {
      options = options || {};
      if (url === BALANCE) return res({ code: 0, data: { configs: { offPeak: { enable_offpeak_task: true, allowed_models: ["glm-5.3-flash"] } } } });
      if (url === AVAIL) return res({ code: 0, data: { can_take_number: true } });
      if (url === TAKE && options.method === "POST") { takes += 1; return res({ code: 0, data: { ticket_id: "tk-" + takes, status: "active" } }); }
      if (url === STATUS) return res({ code: 0, data: { status: "active", next_poll_after: 0 } });
      if (String(url).endsWith("/settle")) return res({ code: 0, data: {} });
      throw new Error("unexpected " + url);
    });
    const executor = new ZcodeExecutor();
    const credentials = baseCreds();
    const superExecute = vi.spyOn(Object.getPrototypeOf(ZcodeExecutor.prototype), "execute").mockImplementation(async () => (takes >= 2 ? okUpstream() : liveResponse({ code: 3102, message: "ticket expired" }, 400)));
    await executor.execute({ model: "glm-5.3-flash", body: { model: "glm-5.3-flash", messages: [] }, stream: false, credentials, log: console });
    expect(takes).toBeGreaterThanOrEqual(2);
    superExecute.mockRestore();
  });

  it("E5 refresh handler returns rotated shape", async () => {
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    vi.mocked(proxyAwareFetch).mockResolvedValue(res({ access_token: "new-at", expires_in: 3600, refresh_token: "new-rt" }));
    const { refreshZcodeToken } = await import("../../src/lib/oauth/services/zcode.js");
    const out = await refreshZcodeToken("old-rt", {}, console);
    expect(out.accessToken).toBe("new-at");
    expect(out.refreshToken).toBe("new-rt");
  });

  it("import-surface: executor keeps engine-relative imports", async () => {
    const { readFileSync } = await import("node:fs");
    const text = readFileSync(new URL("../../open-sse/executors/zcode.js", import.meta.url), "utf8");
    const specs = [];
    for (const m of text.matchAll(/from ["']([^"']+)["']/g)) specs.push(m[1]);
    expect(specs.length).toBeGreaterThan(0);
    for (const s of specs) expect(s.startsWith("node:") || s.startsWith("../") || s.startsWith("./")).toBe(true);
  });
});
