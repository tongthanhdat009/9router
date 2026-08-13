import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalFetch = global.fetch;

describe("Codex proxy-aware refresh", () => {
  beforeEach(() => { vi.resetModules(); global.fetch = originalFetch; });
  afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

  it("uses per-account proxy via proxyAwareFetch when credentials.__proxyOptions.connectionProxyUrl set", async () => {
    const proxyFetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "a", refresh_token: "r", expires_in: 3600 }),
    });
    // proxyAwareFetch reads from proxyFetch.js; mock that module
    vi.doMock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: proxyFetchSpy }));
    const { refreshCodexToken } = await import("../../open-sse/services/tokenRefresh.js");
    const res = await refreshCodexToken("rt", null, { __proxyOptions: { connectionProxyUrl: "http://acct-proxy:8080" } });
    expect(res.accessToken).toBe("a");
    expect(proxyFetchSpy).toHaveBeenCalled();
    const [url, opts, proxyOptions] = proxyFetchSpy.mock.calls[0];
    expect(url).toContain("/oauth/token");
    expect(proxyOptions && proxyOptions.connectionProxyUrl).toBe("http://acct-proxy:8080");
  });

  it("falls back to global fetch when no account proxy", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "a2", expires_in: 3600 }),
    });
    global.fetch = fetchMock;
    vi.doMock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));
    const { refreshCodexToken } = await import("../../open-sse/services/tokenRefresh.js");
    const res = await refreshCodexToken("rt", null, {});
    expect(res.accessToken).toBe("a2");
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe("dedup never caches null result", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());
  it("consecutive failures each hit network", async () => {
    let calls = 0;
    const { dedupRefresh } = await import("../../open-sse/services/tokenRefresh/dedup.js");
    const fn = async () => { calls++; return null; };
    await dedupRefresh("x", "tok-fail", fn, null);
    await dedupRefresh("x", "tok-fail", fn, null);
    expect(calls).toBe(2);
  });
  it("consecutive successes only hit network once", async () => {
    let calls = 0;
    const { dedupRefresh } = await import("../../open-sse/services/tokenRefresh/dedup.js");
    const fn = async () => { calls++; return { ok: true }; };
    await dedupRefresh("y", "tok-ok", fn, null);
    await dedupRefresh("y", "tok-ok", fn, null);
    expect(calls).toBe(1);
  });
});
