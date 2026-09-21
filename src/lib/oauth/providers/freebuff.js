import crypto from "crypto";

const DEFAULT_AUTH_BASE = "https://www.codebuff.com";
const TERMINAL_ERROR = /expired|invalid_grant|invalid_request|no artwork|no such|consumed/i;

function authBase() {
  return (process.env.NEXT_PUBLIC_CODEBUFF_APP_URL || DEFAULT_AUTH_BASE).replace(/\/$/, "");
}

function requireSecret(value, name) {
  if (!value) throw new Error("FreeBuff device flow is missing " + name);
  return value;
}

async function json(response) {
  try { return await response.json(); } catch { return null; }
}

const freebuff = {
  config: {},
  flowType: "device_code",

  async requestDeviceCode() {
    const fingerprintId = crypto.randomBytes(32).toString("hex");
    const base = authBase();
    let response;
    try {
      response = await fetch(base + "/api/auth/cli/code", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ fingerprintId }),
      });
    } catch { throw new Error("FreeBuff device code request failed"); }
    const data = await json(response);
    let loginUrl;
    try { loginUrl = new URL(data.loginUrl); } catch { throw new Error("FreeBuff device code response is invalid"); }
    if (!response.ok || !/^https?:$/.test(loginUrl.protocol) || typeof data.fingerprintHash !== "string" || !data.fingerprintHash || typeof data.expiresAt !== "string" || !data.expiresAt) {
      throw new Error("FreeBuff device code response is invalid");
    }
    const expiry = Date.parse(data.expiresAt);
    const expiresIn = Number.isFinite(expiry) ? Math.max(1, Math.ceil((expiry - Date.now()) / 1000)) : 3600;
    return {
      device_code: fingerprintId,
      user_code: data.fingerprintHash.slice(0, 8).toUpperCase(),
      verification_uri: loginUrl.toString(),
      verification_uri_complete: loginUrl.toString(),
      expires_in: expiresIn,
      interval: 5,
      _freebuffFingerprintId: fingerprintId,
      _freebuffFingerprintHash: data.fingerprintHash,
      _freebuffExpiresAt: data.expiresAt,
      _freebuffAuthBase: base,
    };
  },

  async pollToken(config, deviceCode, _codeVerifier, extraData) {
    void config; void _codeVerifier;
    const fingerprintId = requireSecret(deviceCode || (extraData && extraData._freebuffFingerprintId), "fingerprintId");
    const fingerprintHash = requireSecret(extraData && extraData._freebuffFingerprintHash, "fingerprintHash");
    const expiresAt = requireSecret(extraData && extraData._freebuffExpiresAt, "expiresAt");
    const base = (extraData && extraData._freebuffAuthBase) || authBase();
    let response;
    try {
      const query = new URLSearchParams({ fingerprintId, fingerprintHash, expiresAt });
      response = await fetch(base + "/api/auth/cli/status?" + query, { headers: { Accept: "application/json" } });
    } catch { return { ok: false, data: { error: "poll_failed" } }; }
    if (response.status === 408 || response.status === 429 || response.status >= 500) return { ok: false, data: { error: "poll_failed" } };
    const data = await json(response);
    const error = [data && data.error, data && data.message].filter((part) => typeof part === "string").join(" ");
    if (TERMINAL_ERROR.test(error)) return { ok: false, data: { error: /expired|consumed/i.test(error) ? "expired_token" : "access_denied" } };
    if (response.status === 401 || !data || !data.user || typeof data.user !== "object") return { ok: true, data: { error: "authorization_pending" } };
    if (typeof data.user.authToken !== "string" || !data.user.authToken.trim()) return { ok: true, data: { error: "authorization_pending" } };
    return { ok: true, data: {
      access_token: data.user.authToken,
      refresh_token: null,
      expires_in: null,
      _freebuffUserId: data.user.id || null,
      _freebuffEmail: data.user.email || null,
      _freebuffName: data.user.name || null,
      _freebuffFingerprintId: fingerprintId,
      _freebuffFingerprintHash: fingerprintHash,
      _freebuffExpiresAt: expiresAt,
      _freebuffAuthBase: base,
    }};
  },

  mapTokens(tokens, extra) {
    if (!tokens || !tokens.access_token || typeof tokens.access_token !== "string") throw new Error("FreeBuff login did not return an access token");
    return {
      accessToken: tokens.access_token,
      refreshToken: null,
      expiresIn: null,
      email: tokens._freebuffEmail || null,
      displayName: tokens._freebuffName || null,
      providerSpecificData: {
        authMethod: "device",
        userId: tokens._freebuffUserId || null,
        fingerprintId: tokens._freebuffFingerprintId || (extra && extra._freebuffFingerprintId) || null,
      },
    };
  },
};

export default freebuff;