import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import freebuff from "../../src/lib/oauth/providers/freebuff.js";

const originalFetch = global.fetch;
const okJson = (payload) => ({ ok: true, status: 200, json: () => Promise.resolve(payload) });
const CODE_OK = () => ({
  loginUrl: "https://www.codebuff.com/auth/cli?fid=abc",
  fingerprintHash: "abcdef1234567890",
  expiresAt: new Date(Date.now() + 600000).toISOString(),
});
const EXTRAS = {
  _freebuffFingerprintId: "fp-1",
  _freebuffFingerprintHash: "deadbeefcafe",
  _freebuffExpiresAt: "2030-01-01T00:00:00.000Z",
};

describe("freebuff oauth adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = originalFetch;
    delete process.env.NEXT_PUBLIC_CODEBUFF_APP_URL;
  });
  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.NEXT_PUBLIC_CODEBUFF_APP_URL;
  });

  it("declares the shared device-code adapter contract", () => {
    expect(freebuff.flowType).toBe("device_code");
    expect(freebuff.config).toEqual({});
  });

  it("requestDeviceCode posts only fingerprintId without auth headers", async () => {
    const fetchMock = vi.fn(async (url, options) => {
      expect(url).toBe("https://www.codebuff.com/api/auth/cli/code");
      expect(options.method).toBe("POST");
      expect(options.headers.Authorization).toBeUndefined();
      expect(options.headers.Cookie).toBeUndefined();
      expect(JSON.parse(options.body)).toEqual({ fingerprintId: expect.stringMatching(/^[0-9a-f]{64}$/) });
      return okJson(CODE_OK());
    });
    global.fetch = fetchMock;
    const data = await freebuff.requestDeviceCode({});
    expect(data.device_code).toMatch(/^[0-9a-f]{64}$/);
    expect(data.user_code).toBe("ABCDEF12");
    expect(data.verification_uri).toBe("https://www.codebuff.com/auth/cli?fid=abc");
    expect(data.verification_uri_complete).toBe(data.verification_uri);
    expect(data.interval).toBe(5);
    expect(data.expires_in).toBeGreaterThan(0);
    expect(data.expires_in).toBeLessThanOrEqual(600);
    expect(data._freebuffFingerprintId).toBe(data.device_code);
    expect(data._freebuffFingerprintHash).toBe("abcdef1234567890");
    expect(data._freebuffAuthBase).toBe("https://www.codebuff.com");
  });

  it("accepts epoch-ms expiresAt and falls back to expiresInMs", async () => {
    global.fetch = vi.fn(async () => okJson({ ...CODE_OK(), expiresAt: 1789981703883, expiresInMs: 3600000 }));
    const data = await freebuff.requestDeviceCode({});
    expect(data.expires_in).toBeGreaterThan(0);
    expect(data._freebuffExpiresAt).toBe(1789981703883);
  });

  it("honors NEXT_PUBLIC_CODEBUFF_APP_URL and maps unparseable expiry to 3600", async () => {
    process.env.NEXT_PUBLIC_CODEBUFF_APP_URL = "https://stage.codebuff.example/";
    global.fetch = vi.fn(async (url) => {
      expect(String(url)).toBe("https://stage.codebuff.example/api/auth/cli/code");
      return okJson({ ...CODE_OK(), expiresAt: "not-a-date" });
    });
    const data = await freebuff.requestDeviceCode({});
    expect(data._freebuffAuthBase).toBe("https://stage.codebuff.example");
    expect(data.expires_in).toBe(3600);
  });

  it("rejects bad payloads without leaking fields", async () => {
    const bads = [
      { ...CODE_OK(), loginUrl: "javascript:alert(1)" },
      { ...CODE_OK(), fingerprintHash: "" },
      {},
      // String-typed expiresAt stays valid (echoed opaque); only missing/NaN forms are invalid.
      { ...CODE_OK(), expiresAt: "" },
      { ...CODE_OK(), expiresAt: Number.NaN },
    ];
    for (const bad of bads) {
      global.fetch = vi.fn(async () => okJson(bad));
      await expect(freebuff.requestDeviceCode({})).rejects.toThrow(/FreeBuff device code/);
    }
    global.fetch = vi.fn(async () => ({ ok: false, status: 502, json: () => Promise.resolve({ error: "secret-sauce" }) }));
    await expect(freebuff.requestDeviceCode({})).rejects.toThrow(/FreeBuff device code/);
  });

  it("pollToken throws naming the missing field without echoing secrets", async () => {
    await expect(freebuff.pollToken({}, null, null, { _freebuffFingerprintHash: EXTRAS._freebuffFingerprintHash, _freebuffExpiresAt: EXTRAS._freebuffExpiresAt })).rejects.toThrow(/missing fingerprintId/);
    await expect(freebuff.pollToken({}, "fp-1", null, {})).rejects.toThrow(/missing fingerprintHash/);
    await expect(freebuff.pollToken({}, "fp-1", null, { _freebuffFingerprintHash: EXTRAS._freebuffFingerprintHash })).rejects.toThrow(/missing expiresAt/);
  });

  it("pollToken maps 401/missing user to authorization_pending without auth headers", async () => {
    global.fetch = vi.fn(async (url, options) => {
      expect(url).toBe("https://www.codebuff.com/api/auth/cli/status?fingerprintId=fp-1&fingerprintHash=deadbeefcafe&expiresAt=2030-01-01T00%3A00%3A00.000Z");
      expect(options.headers.Authorization).toBeUndefined();
      expect(options.headers.Cookie).toBeUndefined();
      return { ok: false, status: 401, json: () => Promise.resolve({}) };
    });
    expect(await freebuff.pollToken({}, "fp-1", null, EXTRAS)).toEqual({ ok: true, data: { error: "authorization_pending" } });
  });

  it("pollToken stays pending while user lacks a usable authToken", async () => {
    for (const body of [{ user: { id: "u1" } }, { user: "garbage" }, {}, null]) {
      global.fetch = vi.fn(async () => okJson(body));
      expect(await freebuff.pollToken({}, "fp-1", null, EXTRAS)).toEqual({ ok: true, data: { error: "authorization_pending" } });
    }
  });

  it("pollToken returns ready metadata when authToken arrives", async () => {
    global.fetch = vi.fn(async () => okJson({ user: { id: "u1", email: "a@b.c", name: "Ann", authToken: "tok-1" } }));
    const result = await freebuff.pollToken({}, "fp-1", null, EXTRAS);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      access_token: "tok-1",
      refresh_token: null,
      expires_in: null,
      _freebuffUserId: "u1",
      _freebuffEmail: "a@b.c",
      _freebuffName: "Ann",
      _freebuffFingerprintId: "fp-1",
      _freebuffFingerprintHash: "deadbeefcafe",
      _freebuffExpiresAt: EXTRAS._freebuffExpiresAt,
      _freebuffAuthBase: "https://www.codebuff.com",
    });
  });

  it("pollToken collapses server expiry errors to coarse classes", async () => {
    const cases = [
      [{ error: "Login request expired" }, "expired_token"],
      [{ error: "Login consumed already" }, "expired_token"],
      [{ error: "no such login request" }, "access_denied"],
      [{ error: "invalid_grant" }, "access_denied"],
      [{ message: "no artwork yet" }, "access_denied"],
    ];
    for (const [body, expected] of cases) {
      global.fetch = vi.fn(async () => okJson(body));
      const result = await freebuff.pollToken({}, "fp-1", null, EXTRAS);
      expect(result).toEqual({ ok: false, data: { error: expected } });
      expect(JSON.stringify(result)).not.toContain("Login");
    }
  });

  it("pollToken returns poll_failed on transport failures without leaking internals", async () => {
    const variants = [
      () => { throw new Error("ECONNRESET top-secret-host"); },
      () => ({ ok: false, status: 408, json: () => Promise.resolve({}) }),
      () => ({ ok: false, status: 429, json: () => Promise.resolve({}) }),
      () => ({ ok: false, status: 503, json: () => Promise.resolve({}) }),
    ];
    for (const variant of variants) {
      global.fetch = vi.fn(variant);
      const result = await freebuff.pollToken({}, "fp-1", null, EXTRAS);
      expect(result).toEqual({ ok: false, data: { error: "poll_failed" } });
      expect(JSON.stringify(result)).not.toContain("secret");
    }
  });

  it("mapTokens persists PSD without fingerprintHash/expiresAt/authToken", () => {
    const tokens = {
      access_token: "tok-1",
      _freebuffFingerprintId: "fp-1",
      _freebuffFingerprintHash: "deadbeefcafe",
      _freebuffExpiresAt: "2030-01-01T00:00:00.000Z",
      _freebuffUserId: "u1",
      _freebuffEmail: "a@b.c",
      _freebuffName: "Ann",
    };
    const mapped = freebuff.mapTokens(tokens, null);
    expect(mapped).toEqual({
      accessToken: "tok-1",
      refreshToken: null,
      expiresIn: null,
      email: "a@b.c",
      displayName: "Ann",
      providerSpecificData: { authMethod: "device", userId: "u1", fingerprintId: "fp-1" },
    });
    expect(Object.keys(mapped.providerSpecificData)).toEqual(["authMethod", "userId", "fingerprintId"]);
    expect(freebuff.mapTokens({ ...tokens, _freebuffFingerprintId: null }, { _freebuffFingerprintId: "fp-2" }).providerSpecificData.fingerprintId).toBe("fp-2");
    expect(() => freebuff.mapTokens({}, null)).toThrow("FreeBuff login did not return an access token");
  });

  it("registers freebuff in the four device-flow gates", () => {
    const route = readFileSync(resolve("../src/app/api/oauth/[provider]/[action]/route.js"), "utf8");
    expect(route.match(/const noPkceDeviceProviders = \[([^\]]*)\]/)[1]).toContain('"freebuff"');
    expect(route.match(/const noPkceProviders = \[([^\]]*)\]/)[1]).toContain('"freebuff"');
    const modal = readFileSync(resolve("../src/shared/components/OAuthModal.js"), "utf8");
    expect(modal.match(/const deviceCodeProviders = \[([^\]]*)\]/)[1]).toContain('"freebuff"');
    expect(modal).toContain("_freebuffFingerprintHash: data._freebuffFingerprintHash");
  });
});