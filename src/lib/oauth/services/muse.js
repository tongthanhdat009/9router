import { MUSE_MINT_BASE } from "../constants/oauth.js";

// Muse (Meta) apiKey mint. Called after OAuth login and on 401 re-mint.
// Never reads a base URL from the mint response; inference origin stays
// providerSpecificData apiBaseUrl/baseUrl (https://api.meta.ai/v1).
function mintBase(config) {
  return (config?.mintBase || MUSE_MINT_BASE).replace(/\/$/, "");
}

export async function mintMuseKey(accessToken, config) {
  if (!accessToken) throw new Error("Missing access token for Muse key mint");
  const response = await fetch(`${mintBase(config)}/muse-code/key`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "x-api-version": "1.0.0",
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ onboard: false }),
  });
  if (!response.ok) {
    const error = await response.text();
    const err = new Error(`Muse key mint failed: ${error}`);
    err.status = response.status;
    throw err;
  }
  const data = await response.json();
  // Lenient parse: api_key plus identity fields when present; ignore the rest.
  if (!data.api_key) throw new Error("Muse key mint response missing api_key");
  return {
    apiKey: data.api_key,
    userEmail: data.user_email || null,
    userFullName: data.user_full_name || null,
  };
}

export async function logoutMuse(accessToken, config) {
  // Best-effort remote logout; caller clears local state regardless of result.
  if (!accessToken) return false;
  try {
    const response = await fetch(`${mintBase(config)}/muse-code/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return response.ok;
  } catch {
    return false;
  }
}
