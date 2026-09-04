import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { refreshProviderCredentials } from "../services/oauthCredentialManager.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import { ZCODE_IDENTITY_HEADERS, zcodeRequestHeaders } from "../utils/zcodeIdentity.js";
import { resolveOffPeakAccess, settleTicket } from "../services/offpeak/zcode.js";
import { ensureCodingPlanKey, invalidateCodingPlanKey, mintCodingPlanKey } from "../services/zcodeKey.js";

const ZCODE_OFFPEAK_URL = "https://zcode.z.ai/api/v1/off-peak/anthropic/v1/messages";
const ZCODE_NORMAL_URL = "https://api.z.ai/api/anthropic/v1/messages";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class ZcodeExecutor extends BaseExecutor {
  constructor() {
    super("zcode", PROVIDERS.zcode);
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null, requestId = null, preparedRequest = null }) {
    const sessionId = resolveSessionId({ headers: credentials?.rawHeaders, body, connectionId: credentials?.connectionId, scope: "zcode" });
    // Per-request channel state rides the per-request credentials object
    // (chatCore passes a fresh object per invocation) — never the executor.
    credentials.__zcodeChannel = { channel: "normal", ticketId: null, sessionId, recovered: false };
    const ch = credentials.__zcodeChannel;

    // Option B ensure-key gate: mint-or-cache df8d before ANY dispatch; without a
    // key api.z.ai 401s, so fail closed with remediation (no empty-string headers).
    let keyError = null;
    ch.key = await ensureCodingPlanKey(credentials, proxyOptions).catch((error) => {
      keyError = error;
      return null;
    });
    if (!ch.key) {
      const message = keyError?.code === "coding_plan_not_entitled"
        ? "zcode: account has no coding plan. Paste a key from https://z.ai/manage-apikey or upgrade."
        : keyError?.code === "coding_plan_not_connected"
          ? "zcode: coding plan not connected. Paste a key from https://z.ai/manage-apikey or connect the plan."
          : "zcode: no coding-plan API key. Paste one (dashboard connection edit, from https://z.ai/manage-apikey) or re-login to mint.";
      // Return an upstream-shaped 401 rather than throwing: chatCore records the real
      // status and may run its existing OAuth refresh/retry path exactly once.
      return {
        response: new Response(JSON.stringify({ error: { message, code: keyError?.code || "coding_plan_key_missing" } }), { status: 401, headers: { "Content-Type": "application/json" } }),
        url: ZCODE_NORMAL_URL,
        headers: {},
        transformedBody: body,
      };
    }

    // Channel pick (E1/E2): eligible model + open window -> off-peak ticket.
    if (credentials?.providerSpecificData?.zcodeJwtToken) {
      const access = await resolveOffPeakAccess(credentials, model, proxyOptions);
      if (access.ok) {
        ch.channel = "offpeak";
        ch.ticketId = access.ticketId;
      }
    }
    return this.dispatchOffPeak({ model, body, stream, credentials, signal, log, proxyOptions, requestId, preparedRequest });
  }

  // Inference-layer retry (E3/E4): bounded 2 off-peak dispatches + 1 normal.
  async dispatchOffPeak(args) {
    const { model, body, stream, credentials, signal, log, proxyOptions, requestId, preparedRequest } = args;
    const ch = credentials.__zcodeChannel;
    // Classify live non-OK upstream bodies: BaseExecutor returns the raw fetch
    // Response, so read its payload once (clone: downstream still consumes it).
    const classify = async (result) => {
      const response = result?.response;
      if (response && typeof response === "object" && typeof response.ok === "boolean" && !response.ok) {
        try {
          const payload = await response.clone().json().catch(() => null);
          const code = payload && (payload.code ?? payload.data?.code ?? payload.error?.code);
          const haystack = JSON.stringify(payload ?? "") + " " + (await response.clone().text().catch(() => ""));
          if (code === 3105 || haystack.includes("3105")) return { code: 3105, retryAfterMs: Number(response.headers?.get?.("retry-after")) * 1000 || null };
          if (code === 3102 || haystack.includes("3102")) return { code: 3102, retryAfterMs: null };
          const statusCode = response.status;
          if (statusCode === 401 || statusCode === 403) return { code: "auth", retryAfterMs: null };
          return null;
        } catch {
          return null;
        }
      }
      const message = typeof result === "string" ? result : result?.response?.message || result?.message || "";
      if (String(message).includes("3105")) return { code: 3105, retryAfterMs: Number(result?.response?.retryAfterMs) || null };
      if (String(message).includes("3102")) return { code: 3102, retryAfterMs: null };
  const status = result?.response?.status ?? result?.error?.status;
  if (status === 401 || status === 403) return { code: "auth", retryAfterMs: null };
      return null;
    };

    let result;
    try {
      result = await super.execute({ model, body, stream, credentials, signal, log, proxyOptions, requestId, preparedRequest });
    } catch (error) {
      result = { error };
    }
    let hit = await classify(result);
    if (!hit || ch.recovered) {
      if (result && result.error) throw result.error;
      return result;
    }

    ch.recovered = true;
    if (hit.code === "auth") {
      // Option B: stale/invalid df8d -> single-flight re-mint, retry once.
      // OAuth token refresh stays owned by the GENERIC chatCore 401 path.
      invalidateCodingPlanKey(credentials.connectionId);
      ch.key = await mintCodingPlanKey(credentials, proxyOptions).then((m) => (m ? m.key : null)).catch(() => null);
      if (!ch.key) return this.dispatchNormal(args);
    } else if (hit.code === 3105) {
      await sleep(Math.min(10000, hit.retryAfterMs || Number(result?.response?.retryAfterMs) || 3000));
    } else {
      await settleTicket(credentials, ch.ticketId, proxyOptions);
      const fresh = await resolveOffPeakAccess(credentials, model, proxyOptions);
      if (!fresh.ok) return this.dispatchNormal(args);
      ch.channel = "offpeak";
      ch.ticketId = fresh.ticketId;
    }

    try {
      result = await super.execute({ model, body, stream, credentials, signal, log, proxyOptions, requestId, preparedRequest });
      hit = await classify(result);
    } catch (error) {
      return this.dispatchNormal(args);
    }
    if (!hit) return result;
    return this.dispatchNormal(args);
  }

  async dispatchNormal(args) {
    const { model, body, stream, credentials, signal, log, proxyOptions, requestId, preparedRequest } = args;
    const ch = credentials.__zcodeChannel;
    ch.channel = "normal";
    ch.ticketId = null;
    return super.execute({ model, body, stream, credentials, signal, log, proxyOptions, requestId, preparedRequest });
  }

  transformRequest(model, body, stream, credentials) {
    const ch = credentials?.__zcodeChannel;
    body.metadata = {
      ...(body.metadata || {}),
      user_id: JSON.stringify({
        device_id: credentials?.providerSpecificData?.deviceId || credentials?.connectionId || "",
        account_uuid: credentials?.providerSpecificData?.userId || "",
        session_id: ch?.sessionId || credentials?.connectionId || "",
      }),
    };
    return body;
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    return credentials?.__zcodeChannel?.channel === "offpeak" ? ZCODE_OFFPEAK_URL : ZCODE_NORMAL_URL;
  }

  buildHeaders(credentials, stream, url, model, ctx) {
    const ch = credentials?.__zcodeChannel;
    const headers = { ...super.buildHeaders(credentials, stream, url, model, ctx), ...zcodeRequestHeaders(ch?.sessionId) };

    const psd = credentials?.providerSpecificData || {};
    if (ch?.channel === "offpeak") {
      headers["Authorization"] = "Bearer " + (psd.zcodeJwtToken || "");
      headers["X-Coding-Plan-Api-Key"] = ch.key || psd.codingPlanApiKey || "";
      headers["X-Off-Peak-Ticket-ID"] = ch.ticketId || "";
    } else {
      const apiKey = ch.key || psd.codingPlanApiKey || credentials?.apiKey || null;
      headers["x-api-key"] = apiKey || "";
      headers["Authorization"] = "Bearer " + (apiKey || "");
    }
    return headers;
  }

  // Generic single-flight refresh (merge + persistence + lock inside
  // refreshProviderCredentials; 3-arg codex.js:258-260 convention).
  async refreshCredentials(credentials, log, proxyOptions = null, status = null) {
    void status;
    return refreshProviderCredentials("zcode", { ...credentials, __proxyOptions: proxyOptions }, log);
  }
}
