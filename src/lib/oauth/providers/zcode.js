import crypto from "crypto";
import { ZCODE_INIT_URL, ZCODE_POLL_URL } from "../constants/oauth.js";

const nowSec = () => Math.floor(Date.now() / 1000);

async function postInit(url, pollToken) {
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + pollToken, "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "zai" }),
  });
  const payload = await response.json();
  if (!response.ok || payload?.code !== 0) throw new Error(payload?.msg || ("ZCode request failed (" + response.status + ")"));
  return payload.data;
}

const zcode = {
  async requestDeviceCode() {
    const pollToken = crypto.randomBytes(32).toString("hex");
    const data = await postInit(ZCODE_INIT_URL, pollToken);
    return {
      device_code: data.flow_id,
      verification_uri: data.authorize_url,
      verification_uri_complete: data.authorize_url,
      expires_in: Math.max(60, Number(data.expires_at) - nowSec()),
      interval: 2,
      _zcodePollToken: pollToken,
    };
  },
  async pollToken(config, deviceCode, codeVerifier, extraData) {
    void config;
    void codeVerifier;
    const pollToken = extraData?._zcodePollToken;
    if (!pollToken) throw new Error("ZCode device flow is missing its poll token");
    const response = await fetch(ZCODE_POLL_URL + encodeURIComponent(deviceCode), {
      headers: { Authorization: "Bearer " + pollToken },
    });
    const payload = await response.json();
    if (!response.ok || payload?.code !== 0) {
      return { ok: false, data: { error: "access_denied", error_description: payload?.msg || "ZCode poll failed" } };
    }
    const data = payload.data || {};
    if (data.status === "pending") return { ok: true, data: { error: "authorization_pending" } };
    if (data.status === "failed") return { ok: true, data: { error: "access_denied", error_description: "zcode flow failed" } };
    if (data.status === "ready") return { ok: true, data: { access_token: data.zai?.access_token || "zcode-ready", ...data } };
    return { ok: false, data: { error: "access_denied", error_description: "Unexpected ZCode flow status" } };
  },
  mapTokens(tokens) {
    return {
      accessToken: tokens.zai?.access_token || null,
      refreshToken: tokens.zai?.refresh_token || null,
      expiresIn: tokens.zai?.expires_at ? Math.max(0, Number(tokens.zai.expires_at) - nowSec()) : null,
      email: tokens.user?.email || null,
      providerSpecificData: {
        zcodeJwtToken: tokens.token,
        deviceId: crypto.randomUUID(),
        codingPlanApiKey: null,
        userId: tokens.user?.user_id || null,
      },
    };
  },
};

export default zcode;
