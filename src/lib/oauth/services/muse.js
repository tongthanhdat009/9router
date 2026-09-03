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
  // subs_usage arrives inside the same mint response (percent-only quota
  // snapshot); tolerate missing/null so login never breaks when Meta omits it.
  if (!data.api_key) throw new Error("Muse key mint response missing api_key");
  const usage = data.subs_usage && typeof data.subs_usage === "object" ? data.subs_usage : null;
  return {
    apiKey: data.api_key,
    userEmail: data.user_email || null,
    userFullName: data.user_full_name || null,
    // Tier/active arrive top-level, not inside subs_usage.
    tierName: data.subs_tier_name ?? data.tier_name ?? null,
    isSubsActive: data.is_subs_active ?? data.is_active ?? null,
    ...(usage ? { museUsage: { ...usage, fetchedAt: Date.now() } } : {}),
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
