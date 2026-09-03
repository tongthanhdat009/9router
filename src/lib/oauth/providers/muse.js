import { MUSE_CONFIG, MUSE_AUTH_BASE, MUSE_CLIENT_ID, MUSE_API_BASE } from "../constants/oauth.js";

// Muse (Meta) device-code login. Device auth request carries only client_id
// (form-urlencoded); token poll carries the device_code grant triple.
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

function authBase(config) {
  return (config?.authBase || MUSE_AUTH_BASE).replace(/\/$/, "");
}

function clientId(config) {
  return config?.clientId || MUSE_CLIENT_ID;
}

const muse = {
  config: MUSE_CONFIG,
  flowType: "device_code",
  requestDeviceCode: async (config) => {
    const response = await fetch(`${authBase(config)}/oidc/device/authorization/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({ client_id: clientId(config) }),
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Device code request failed: ${error}`);
    }
    const data = await response.json();
    if (!data.user_code || !data.verification_uri) {
      throw new Error("Device code response missing user_code or verification_uri");
    }
    return {
      device_code: data.device_code,
      user_code: data.user_code,
      verification_uri: data.verification_uri,
      verification_uri_complete: data.verification_uri_complete || data.verification_uri,
      expires_in: data.expires_in,
      interval: data.interval || 5,
    };
  },
  pollToken: async (config, deviceCode) => {
    const response = await fetch(`${authBase(config)}/oidc/device/token/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: DEVICE_CODE_GRANT,
        client_id: clientId(config),
        device_code: deviceCode,
      }),
    });
    let data;
    try {
      data = await response.json();
    } catch {
      data = { error: "invalid_response", error_description: "non-json token response" };
    }
    // Pending states ride ok:true so the shared poller maps them to pending,
    // matching the kimi precedent; terminal errors ride ok:false.
    if (data.error === "authorization_pending" || data.error === "slow_down") {
      return { ok: true, data };
    }
    if (data.access_token) return { ok: true, data };
    return {
      ok: false,
      data: {
        error: data.error || "no_access_token",
        error_description: data.error_description || data.message,
      },
    };
  },
  mapTokens: (tokens) => ({
    accessToken: tokens.access_token,
    // Stored for compat/audit only; never used (Muse has no refresh grant).
    refreshToken: tokens.refresh_token || null,
    expiresIn: tokens.expires_in,
    email: null,
    providerSpecificData: {
      authMethod: "device_code",
      mechanism: "oauth",
      obtainedVia: "device_code",
      apiBaseUrl: MUSE_API_BASE,
      baseUrl: MUSE_API_BASE,
    },
  }),
};

export default muse;
