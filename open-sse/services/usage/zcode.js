import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { parseResetTime } from "./shared.js";

// ZCode coding-plan usage: GET billing/balance with the connection JWT and map
// grant/used/remaining/total_units into the shared quota shape.
export async function getZcodeUsage(credentials, proxyOptions = null, { force } = {}) {
  void force;
  const jwt = credentials?.providerSpecificData?.zcodeJwtToken;
  if (!jwt) return { message: "ZCode JWT not available. Complete the device-flow login first." };
  try {
    const response = await proxyAwareFetch(
      "https://zcode.z.ai/api/v1/zcode-plan/billing/balance",
      { headers: { Authorization: "Bearer " + jwt, Accept: "application/json" } },
      proxyOptions,
    );
    if (!response.ok) {
      if (response.status === 401) return { message: "ZCode JWT invalid or expired. Re-login required." };
      return { message: "ZCode billing API error (" + response.status + ")." };
    }
    const json = await response.json();
    const data = json?.data && typeof json.data === "object" ? json.data : {};
    const grant = Number(data.grant_units ?? data.total_units) || 0;
    const used = Number(data.used_units) || 0;
    const remaining = Number(data.remaining_units ?? Math.max(0, grant - used)) || 0;
    const total = Number(data.total_units) || grant;
    return {
      quotas: {
        "Coding plan": {
          used,
          total: total || grant,
          remaining,
          remainingPercent: total ? Math.max(0, Math.min(100, (remaining / total) * 100)) : 0,
          resetAt: parseResetTime(data.expires_at ?? data.reset_at) || null,
          unlimited: false,
        },
      },
    };
  } catch (error) {
    return { message: "ZCode usage fetch failed: " + (error?.message || error) };
  }
}
