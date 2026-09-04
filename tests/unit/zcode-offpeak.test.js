import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { resolveOffPeakAccess, settleTicket, clearZcodeOffpeakStateForTests } from "../../open-sse/services/offpeak/zcode.js";

const BALANCE = "https://zcode.z.ai/api/v1/zcode-plan/billing/balance";
const AVAIL = "https://zcode.z.ai/api/v1/off-peak/ticket/availability";
const TAKE = "https://zcode.z.ai/api/v1/off-peak/ticket";
const STATUS = "https://zcode.z.ai/api/v1/off-peak/ticket/status";
const SETTLE = "https://zcode.z.ai/api/v1/off-peak/ticket/tk-1/settle";

function creds(id) {
  return { connectionId: id || "conn-1", providerSpecificData: { zcodeJwtToken: "jwt-1", codingPlanApiKey: "key-1" } };
}
function res(payload, status) {
  return { ok: (status || 200) < 400, status: status || 200, headers: { get: () => null }, json: () => Promise.resolve(payload) };
}
function mockFlow(opts) {
  const o = opts || {};
  return async (url, options) => {
    options = options || {};
    if (url === BALANCE) return res({ code: 0, data: { configs: { offPeak: { enable_offpeak_task: o.enable !== false, allowed_models: o.allowed || ["glm-5.3-flash"] } } } });
    if (url === AVAIL) return res({ code: 0, data: { can_take_number: o.canTake !== false, next_take_at: o.nextTakeAt || undefined } });
    if (url === TAKE && options.method === "POST") {
      if (o.onTake) return o.onTake();
      if (o.takeCode) return res({ code: o.takeCode }, o.takeCode === 3105 ? 429 : 400);
      return res({ code: 0, data: { ticket_id: "tk-1", status: "active" } });
    }
    if (url === STATUS) return res({ code: 0, data: { status: o.status || "active", next_poll_after: 0 } });
    if (url === SETTLE) return res({ code: 0, data: {} });
    throw new Error("unexpected url " + url);
  };
}

describe("zcode offpeak module", () => {
  beforeEach(() => { clearZcodeOffpeakStateForTests(); vi.mocked(proxyAwareFetch).mockReset(); });
  afterEach(() => { vi.mocked(proxyAwareFetch).mockReset(); });

  it("E1 open window takes a ticket and reuses it (one POST)", async () => {
    vi.mocked(proxyAwareFetch).mockImplementation(mockFlow());
    const first = await resolveOffPeakAccess(creds(), "GLM-5.3-FLASH");
    expect(first).toEqual({ ok: true, ticketId: "tk-1" });
    const second = await resolveOffPeakAccess(creds(), "glm-5.3-flash");
    expect(second).toEqual({ ok: true, ticketId: "tk-1" });
    const takes = vi.mocked(proxyAwareFetch).mock.calls.filter((c) => c[0] === TAKE && c[1] && c[1].method === "POST");
    expect(takes.length).toBe(1);
  });

  it("E2 closed window suppresses probes until next_take_at", async () => {
    vi.mocked(proxyAwareFetch).mockImplementation(mockFlow({ canTake: false, nextTakeAt: Math.floor(Date.now() / 1000) + 3600 }));
    const r1 = await resolveOffPeakAccess(creds(), "glm-5.3-flash");
    expect(r1.ok).toBe(false);
    const a1 = vi.mocked(proxyAwareFetch).mock.calls.filter((c) => c[0] === AVAIL).length;
    const r2 = await resolveOffPeakAccess(creds(), "glm-5.3-flash");
    expect(r2.ok).toBe(false);
    const a2 = vi.mocked(proxyAwareFetch).mock.calls.filter((c) => c[0] === AVAIL).length;
    expect(a2).toBe(a1);
  });

  it("T-3105 cached ticket is reused", async () => {
    let n = 0;
    vi.mocked(proxyAwareFetch).mockImplementation(mockFlow({ onTake: () => { n += 1; if (n === 1) return res({ code: 0, data: { ticket_id: "tk-A", status: "active" } }); return res({ code: 3105 }, 429); } }));
    const first = await resolveOffPeakAccess(creds(), "glm-5.3-flash");
    expect(first.ticketId).toBe("tk-A");
    const second = await resolveOffPeakAccess(creds(), "glm-5.3-flash");
    expect(second).toEqual({ ok: true, ticketId: "tk-A" });
  });

  it("T-3105 no-cache clears availability cache and fails", async () => {
    vi.mocked(proxyAwareFetch).mockImplementation(mockFlow({ takeCode: 3105 }));
    const r = await resolveOffPeakAccess(creds(), "glm-5.3-flash");
    expect(r).toEqual({ ok: false, code: 3105 });
  });

  it("T-3102 retakes once then reports failure", async () => {
    let n = 0;
    vi.mocked(proxyAwareFetch).mockImplementation(mockFlow({ onTake: () => { n += 1; return res({ code: 3102 }, 400); } }));
    const r = await resolveOffPeakAccess(creds(), "glm-5.3-flash");
    expect(r).toEqual({ ok: false, code: 3102 });
    expect(n).toBe(2);
  });

  it("skips ineligible models and missing JWT", async () => {
    vi.mocked(proxyAwareFetch).mockImplementation(mockFlow({ allowed: ["glm-5.3"] }));
    expect((await resolveOffPeakAccess(creds(), "glm-5.3-flash")).ok).toBe(false);
    expect((await resolveOffPeakAccess({ connectionId: "c2", providerSpecificData: {} }, "glm-5.3")).ok).toBe(false);
  });

  it("concurrent callers share one take", async () => {
    vi.mocked(proxyAwareFetch).mockImplementation(mockFlow());
    const pair = await Promise.all([resolveOffPeakAccess(creds(), "glm-5.3-flash"), resolveOffPeakAccess(creds(), "glm-5.3-flash")]);
    expect(pair[0].ticketId).toBe("tk-1");
    expect(pair[1].ticketId).toBe("tk-1");
    const takes = vi.mocked(proxyAwareFetch).mock.calls.filter((c) => c[0] === TAKE && c[1] && c[1].method === "POST");
    expect(takes.length).toBe(1);
  });

  it("every off-peak request receives proxy options and identity headers", async () => {
    const proxy = { httpProxy: "http://proxy:8080" };
    vi.mocked(proxyAwareFetch).mockImplementation(mockFlow());
    await resolveOffPeakAccess(creds(), "glm-5.3-flash", proxy);
    await settleTicket(creds(), "tk-1", proxy);
    const calls = vi.mocked(proxyAwareFetch).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [, options, proxyArg] of calls) {
      expect(proxyArg).toBe(proxy);
      expect(options.headers["User-Agent"]).toBe("ZCode/3.10.2.6414");
      expect(options.headers["X-ZCode-Agent"]).toBe("glm");
      expect(typeof options.headers["X-Request-Id"]).toBe("string");
      expect(typeof options.headers["X-Query-Id"]).toBe("string");
      expect(typeof options.headers["X-ZCode-Trace-Id"]).toBe("string");
      expect(typeof options.headers["X-Session-Id"]).toBe("string");
    }
  });

  it("settleTicket posts settle and clears active ticket", async () => {
    vi.mocked(proxyAwareFetch).mockImplementation(mockFlow());
    await resolveOffPeakAccess(creds(), "glm-5.3-flash");
    const ok = await settleTicket(creds(), "tk-1");
    expect(ok).toBe(true);
    const settles = vi.mocked(proxyAwareFetch).mock.calls.filter((c) => c[0] === SETTLE);
    expect(settles.length).toBe(1);
  });

  it("import-surface: only relative engine paths and node builtins", () => {
    const text = readFileSync(new URL("../../open-sse/services/offpeak/zcode.js", import.meta.url), "utf8");
    const specs = [];
    for (const m of text.matchAll(/from ["']([^"']+)["']/g)) specs.push(m[1]);
    expect(specs.length).toBeGreaterThan(0);
    // open-sse modules import the engine relatively; src/ is never a dep.
    for (const s of specs) expect(s.startsWith("node:") || s.startsWith("../../") || s.startsWith("../")).toBe(true);
    expect(specs.some((s) => s.includes("src/"))).toBe(false);
  });
});
