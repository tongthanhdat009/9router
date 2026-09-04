import crypto from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { refreshProviderCredentials } from "../services/oauthCredentialManager.js";
import { resolveSessionId } from "../utils/sessionManager.js";

const ZCODE_OFFPEAK_URL = "https://zcode.z.ai/api/v1/off-peak/anthropic/v1/messages";
const ZCODE_NORMAL_URL = "https://api.z.ai/api/anthropic/v1/messages";

const ZCODE_IDENTITY_HEADERS = Object.freeze({
  "User-Agent": "ZCode/3.10.2.6414",
  "HTTP-Referer": "https://zcode.z.ai",
  "X-ZCode-Agent": "glm",
  "X-ZCode-App-Version": "3.10.2.6414",
  "X-ZCode-Session-Type": "main",
  "X-Release-Channel": "production",
  "X-Title": "Z Code@desktop",
  "X-Platform": "linux-x64",
  "X-OS-Category": "linux",
  "X-OS-Version": "6.8.0",
  "X-Client-Language": "en-US",
  "X-Client-Timezone": "America/Los_Angeles",
});

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

    // TODO(Task5): channel decision + inference retry wrapper here.
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
    const headers = { ...super.buildHeaders(credentials, stream, url, model, ctx), ...ZCODE_IDENTITY_HEADERS };
    const ch = credentials?.__zcodeChannel;
    headers["X-Request-Id"] = crypto.randomUUID();
    headers["X-Query-Id"] = crypto.randomUUID();
    headers["X-ZCode-Trace-Id"] = crypto.randomUUID();
    if (ch?.sessionId) headers["X-Session-Id"] = ch.sessionId;

    const psd = credentials?.providerSpecificData || {};
    if (ch?.channel === "offpeak") {
      headers["Authorization"] = "Bearer " + (psd.zcodeJwtToken || "");
      headers["X-Coding-Plan-Api-Key"] = psd.codingPlanApiKey || "";
      headers["X-Off-Peak-Ticket-ID"] = ch.ticketId || "";
    } else {
      const apiKey = psd.codingPlanApiKey || credentials?.apiKey || null;
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
