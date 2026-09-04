import { ZCODE_CLIENT_ID, ZCODE_TOKEN_URL } from "../constants/oauth.js";

// Pure zcode OAuth refresh: POST form-urlencoded grant to ZCode token endpoint.
// No persistence, no lock — refreshProviderCredentials owns merge/persist.
// VERIFY-LIVE: whether a fresh zcodeJwtToken comes back; if the body carries a
// JWT-shaped token we surface it so the generic PSD merge stores it.
export async function refreshZcodeToken(refreshToken, credentials, log) {
  if (!refreshToken) return null;
  const proxyOptions = credentials?.__proxyOptions || null;
  const { proxyAwareFetch } = await import("open-sse/utils/proxyFetch.js");
  const response = await proxyAwareFetch(
    ZCODE_TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        client_id: ZCODE_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    },
    proxyOptions,
  );
  if (!response.ok) {
    const errorText = await response.text();
    log?.warn?.("TOKEN_REFRESH", "zcode refresh failed " + response.status + ": " + errorText.slice(0, 200));
    const err = new Error("zcode refresh failed (" + response.status + ")");
    err.status = response.status;
    throw err;
  }
  const data = await response.json();
  const result = {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
    ...(data.refresh_token && data.refresh_token !== refreshToken ? { refreshToken: data.refresh_token } : {}),
  };
  if (typeof data.token === "string" && data.token.split(".").length === 3) {
    result.providerSpecificData = { zcodeJwtToken: data.token };
  }
  // Option B: opportunistically mint the coding-plan key so the GENERIC PSD merge
  // (ocm:99-104 + chat.js onCredentialsRefreshed) persists it. Mint failure must
  // never fail the refresh — key is lazily minted at next inference instead.
  try {
    if (result.accessToken && !result.providerSpecificData?.codingPlanApiKey) {
      const { mintCodingPlanKey } = await import("../../../../open-sse/services/zcodeKey.js");
      const minted = await mintCodingPlanKey({ accessToken: result.accessToken, connectionId: credentials?.connectionId }, credentials?.__proxyOptions || null);
      result.providerSpecificData = { ...(result.providerSpecificData || {}), codingPlanApiKey: minted.key };
    }
  } catch (e) {
    log?.warn?.("TOKEN_REFRESH", "zcode coding-plan key mint deferred: " + (e.code || e.message));
  }
  return result;
}
