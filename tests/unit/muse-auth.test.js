/**
 * Muse (Meta) auth matrix: device-code login, key mint, 401 re-mint,
 * expiry bypass, direct-key. Fetch stubbed per test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const originalFetch = global.fetch;

function jsonResponse(payload, opts) {
  const ok = !opts || opts.ok !== false;
  const status = (opts && opts.status) || 200;
  return {
    ok, status,
    text: () => Promise.resolve(typeof payload === "string" ? payload : JSON.stringify(payload)),
    json: () => (typeof payload === "string" ? Promise.reject(new Error("non-json")) : Promise.resolve(payload)),
  };
}

async function freshMuseProvider() {
  vi.resetModules();
  const mod = await import("../../src/lib/oauth/providers/muse.js");
  return mod.default;
}

async function freshMuseService() {
  vi.resetModules();
  return import("../../src/lib/oauth/services/muse.js");
}

async function freshMuseExecutor() {
  vi.resetModules();
  const mod = await import("../../open-sse/executors/muse.js");
  return new mod.MuseExecutor();
}

describe('muse-auth', () => {
  beforeEach(() => { vi.clearAllMocks(); global.fetch = originalFetch; });
  afterEach(() => { global.fetch = originalFetch; });

  it('device-code request carries only client_id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ device_code: "dev-1", user_code: "ABCD-1234", verification_uri: "https://auth.meta.com/device" }));
    global.fetch = fetchMock;
    const muse = await freshMuseProvider();
    const out = await muse.requestDeviceCode({ authBase: "https://auth.meta.com", clientId: "1031625952748946" });
    expect(out.user_code).toBe("ABCD-1234");
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe("https://auth.meta.com/oidc/device/authorization/");
    expect(call[1].method).toBe("POST");
    expect(call[1].body.toString()).toBe("client_id=1031625952748946");
  });

  it('throws when user_code or verification_uri missing', async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ device_code: "dev-1" }));
    const muse = await freshMuseProvider();
    await expect(muse.requestDeviceCode({})).rejects.toThrow(/user_code|verification_uri/);
  });

  it('token poll body carries exact device_code grant triple', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ access_token: "at-1" }));
    global.fetch = fetchMock;
    const muse = await freshMuseProvider();
    const out = await muse.pollToken({ authBase: "https://auth.meta.com", clientId: "1031625952748946" }, "dev-1");
    expect(out.ok).toBe(true);
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe("https://auth.meta.com/oidc/device/token/");
    const body = call[1].body.toString();
    expect(body).toContain("grant_type=urn");
    expect(body).toContain("device_code=dev-1");
    expect(body).toContain("client_id=1031625952748946");
  });

  it('authorization_pending and slow_down stay pending', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(jsonResponse({ error: "authorization_pending" })).mockResolvedValueOnce(jsonResponse({ error: "slow_down" }));
    const muse = await freshMuseProvider();
    const a = await muse.pollToken({}, "dev-1");
    const b = await muse.pollToken({}, "dev-1");
    expect(a.ok).toBe(true);
    expect(a.data.error).toBe("authorization_pending");
    expect(b.ok).toBe(true);
    expect(b.data.error).toBe("slow_down");
  });

  it('expired_token and access_denied fail', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(jsonResponse({ error: "expired_token" })).mockResolvedValueOnce(jsonResponse({ error: "access_denied" }));
    const muse = await freshMuseProvider();
    const a = await muse.pollToken({}, "dev-1");
    const b = await muse.pollToken({}, "dev-1");
    expect(a.ok).toBe(false);
    expect(a.data.error).toBe("expired_token");
    expect(b.ok).toBe(false);
    expect(b.data.error).toBe("access_denied");
  });

  it('defaults interval to 5s and honors server interval', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(jsonResponse({ device_code: "d", user_code: "U", verification_uri: "https://x" })).mockResolvedValueOnce(jsonResponse({ device_code: "d", user_code: "U", verification_uri: "https://x", interval: 9 }));
    const muse = await freshMuseProvider();
    const a = await muse.requestDeviceCode({});
    const b = await muse.requestDeviceCode({});
    expect(a.interval).toBe(5);
    expect(b.interval).toBe(9);
  });

  it('mint uses accessToken Bearer plus x-api-version plus onboard false', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ api_key: "mk-123", user_email: "u@meta.ai", user_full_name: "Meta User", ignored_field: "drop" }));
    global.fetch = fetchMock;
    const svc = await freshMuseService();
    const out = await svc.mintMuseKey("at-1", { mintBase: "https://api.meta.ai" });
    expect(out).toMatchObject({ apiKey: "mk-123", userEmail: "u@meta.ai", userFullName: "Meta User", tierName: null, isSubsActive: null });
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe("https://api.meta.ai/muse-code/key");
    expect(call[1].headers.Authorization).toBe("Bearer at-1");
    expect(call[1].headers["x-api-version"]).toBe("1.0.0");
    expect(call[1].body).toBe('{"onboard":false}');
  });

  it('mint throws when api_key missing', async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ user_email: "u@meta.ai" }));
    const svc = await freshMuseService();
    await expect(svc.mintMuseKey("at-1", {})).rejects.toThrow(/api_key/);
  });

  it('captures subscription usage only when mint provides it', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(jsonResponse({
      api_key: "mk-usage",
      subs_tier_name: "Pro",
      is_subs_active: true,
      subs_usage: { window: { used_percent: 25, resets_at: 1700000000 } },
    })).mockResolvedValueOnce(jsonResponse({ api_key: "mk-no-usage", subs_usage: null }));
    const svc = await freshMuseService();
    const usage = await svc.mintMuseKey("at-1", {});
    const noUsage = await svc.mintMuseKey("at-1", {});
    expect(usage.museUsage.window.used_percent).toBe(25);
    expect(usage.museUsage.fetchedAt).toEqual(expect.any(Number));
    expect(usage.tierName).toBe("Pro");
    expect(usage.isSubsActive).toBe(true);
    expect(noUsage.museUsage).toBeUndefined();
  });

  it('responses uses apiKey Bearer with no accessToken and no x-api-key', async () => {
    const ex = await freshMuseExecutor();
    const headers = ex.buildHeaders({ apiKey: "mk-123", accessToken: "at-1", refreshToken: "rt-1" }, true);
    expect(headers.Authorization).toBe("Bearer mk-123");
    expect(headers["x-api-key"]).toBeUndefined();
    const serialized = JSON.stringify(headers);
    expect(serialized).not.toContain("at-1");
    expect(serialized).not.toContain("rt-1");
    expect(headers["x-api-version"]).toBeUndefined();
    expect(ex.buildUrl(null, true, 0, { providerSpecificData: { apiBaseUrl: "https://api.meta.ai/v1" } })).toBe("https://api.meta.ai/v1/responses");
  });

  it('forwards session and trace headers from rawHeaders else generates', async () => {
    const ex = await freshMuseExecutor();
    const withRaw = ex.buildHeaders({ apiKey: "mk-1", rawHeaders: { "x-tbh-session-id": "sess-9", "x-client-id": "tbh:tui", traceparent: "00-abc-def-01" } }, true);
    expect(withRaw["x-tbh-session-id"]).toBe("sess-9");
    expect(withRaw["x-client-id"]).toBe("tbh:tui");
    expect(withRaw.traceparent).toBe("00-abc-def-01");
    const generated = ex.buildHeaders({ apiKey: "mk-1" }, true);
    expect(typeof generated["x-tbh-session-id"]).toBe("string");
    expect(typeof generated.traceparent).toBe("string");
    expect(generated["x-client-id"]).toBe("tbh:exec");
  });

  it('401 mints once and returns apiKey; 403 never mints', async () => {
    const mintMock = vi.fn().mockResolvedValue(jsonResponse({ api_key: "mk-new" }));
    global.fetch = mintMock;
    const ex = await freshMuseExecutor();
    const creds = { accessToken: "at-1", providerSpecificData: { apiBaseUrl: "https://api.meta.ai/v1" } };
    const out = await ex.refreshCredentials(creds, null, null, 401);
    expect(out.apiKey).toBe("mk-new");
    expect(mintMock).toHaveBeenCalledTimes(1);
    expect(mintMock.mock.calls[0][0]).toBe("https://api.meta.ai/muse-code/key");
    const noMint = await ex.refreshCredentials({ accessToken: "at-1" }, null, null, 403);
    expect(noMint).toBeNull();
    expect(mintMock).toHaveBeenCalledTimes(1);
  });

  it('mint failure returns unrecoverable sentinel, never throws', async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ error: "revoked" }, { ok: false, status: 401 }));
    const ex = await freshMuseExecutor();
    const out = await ex.refreshCredentials({ accessToken: "at-dead" }, null, null, 401);
    expect(out.error).toBe("unrecoverable_refresh_error");
  });

  it('concurrent 401s share one mint flight', async () => {
    let calls = 0;
    global.fetch = vi.fn().mockImplementation(() => { calls++; return new Promise((resolve) => setTimeout(() => resolve(jsonResponse({ api_key: "mk-shared" })), 20)); });
    const ex = await freshMuseExecutor();
    const creds = { accessToken: "at-1", connectionId: "conn-1", providerSpecificData: {} };
    const pair = await Promise.all([ex.refreshCredentials(creds, null, null, 401), ex.refreshCredentials(creds, null, null, 401)]);
    expect(pair[0].apiKey).toBe("mk-shared");
    expect(pair[1].apiKey).toBe("mk-shared");
    expect(calls).toBe(1);
  });

  it('expired expiresAt blocks neither request shape nor mint', async () => {
    const ex = await freshMuseExecutor();
    const headers = ex.buildHeaders({ apiKey: "mk-1", expiresAt: "2000-01-01T00:00:00.000Z" }, true);
    expect(headers.Authorization).toBe("Bearer mk-1");
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ api_key: "mk-fresh" }));
    const out = await ex.refreshCredentials({ accessToken: "at-stale", expiresAt: "2000-01-01T00:00:00.000Z" }, null, null, 401);
    expect(out.apiKey).toBe("mk-fresh");
  });

  it('direct key bypasses OAuth; direct 401 without accessToken never mints', async () => {
    const mintMock = vi.fn();
    global.fetch = mintMock;
    const ex = await freshMuseExecutor();
    const direct = { apiKey: "direct-key-1" };
    expect(ex.isDirectKey(direct)).toBe(true);
    expect(ex.isDirectKey({ apiKey: "k", accessToken: "at" })).toBe(false);
    const out = await ex.refreshCredentials(direct, null, null, 401);
    expect(out.error).toBe("invalid_muse_key");
    expect(mintMock).not.toHaveBeenCalled();
  });
});
