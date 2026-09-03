import crypto from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { withCredentialRefreshLock } from "../services/oauthCredentialManager.js";
import { MUSE_API_BASE, MUSE_MINT_BASE, MUSE_CONFIG } from "../../src/lib/oauth/constants/oauth.js";
import { mintMuseKey } from "../../src/lib/oauth/services/muse.js";

// Muse (Meta) executor. Inference is POST {apiBase}/responses with Bearer
// apiKey only; the OAuth accessToken never leaves the mint/logout calls.
// 401 recovery is mint-via-accessToken inside the shared single-flight lock;
// 403 and all other statuses use the existing transport/retry path untouched.
const MUSE_REAUTH_MESSAGE = "Saved Muse login is no longer valid. Log in again.";
const MUSE_INVALID_KEY_MESSAGE = "Saved Muse key is invalid. Check the key or log in again.";

function resolveApiBase(credentials) {
  const base =
    credentials?.providerSpecificData?.apiBaseUrl ||
    credentials?.providerSpecificData?.baseUrl ||
    MUSE_API_BASE;
  return String(base).replace(/\/$/, "");
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") return null;
  const want = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === want) return headers[k];
  }
  return null;
}

export class MuseExecutor extends BaseExecutor {
  constructor() {
    super("muse", PROVIDERS.muse);
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    return `${resolveApiBase(credentials)}/responses`;
  }

  buildHeaders(credentials, stream = true, _url = null, _model = null, ctx = {}) {
    // Bearer apiKey ONLY. accessToken / refreshToken / x-api-key never sent here.
    // Explicit direct key wins; stored login apiKey otherwise.
    const directKey = typeof credentials?.apiKey === "string" ? credentials.apiKey : null;
    const headers = {
      Authorization: `Bearer ${directKey || ""}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      // Non-interactive default; TUI-equivalent callers may override via rawHeaders.
      "x-client-id": "tbh:exec",
      "User-Agent": "muse-code/1.0.0 9router",
    };
    const raw = credentials?.rawHeaders || {};
    const passthrough = [
      "x-tbh-session-id",
      "x-meta-ai-gateway-session-id",
      "traceparent",
      "tracestate",
    ];
    for (const name of passthrough) {
      const value = headerValue(raw, name);
      if (value) headers[name] = value;
    }
    const rawClientId = headerValue(raw, "x-client-id");
    if (rawClientId) headers["x-client-id"] = rawClientId;
    if (!headers["x-tbh-session-id"]) headers["x-tbh-session-id"] = ctx?.sessionId || crypto.randomUUID();
    if (!headers["x-meta-ai-gateway-session-id"] && headers["x-tbh-session-id"]) {
      headers["x-meta-ai-gateway-session-id"] = headers["x-tbh-session-id"];
    }
    if (!headers.traceparent) headers.traceparent = `00-${crypto.randomBytes(16).toString("hex")}-${crypto.randomBytes(8).toString("hex")}-01`;
    void stream;
    return headers;
  }

  // Direct-key when the caller configured an explicit key without OAuth tokens.
  isDirectKey(credentials) {
    return !!credentials?.apiKey && !credentials?.accessToken;
  }

  // 401-only mint inside the shared single-flight lock. 403 (or anything else)
  // returns null so existing 403 handling applies. Mint failure returns the
  // unrecoverable sentinel (never throws, never null) so refreshWithRetry
  // short-circuits after exactly one mint flight.
  async refreshCredentials(credentials, log, proxyOptions = null, status = null) {
    void proxyOptions;
    if (status !== null && status !== undefined && status !== 401) return null;
    if (!credentials?.accessToken) {
      return { error: "invalid_muse_key", message: MUSE_INVALID_KEY_MESSAGE };
    }
    return withCredentialRefreshLock("muse", credentials, async () => {
      try {
        const minted = await mintMuseKey(credentials.accessToken, {
          ...(MUSE_CONFIG || {}),
          mintBase: MUSE_MINT_BASE,
        });
        if (credentials) credentials.apiKey = minted.apiKey;
        return {
          apiKey: minted.apiKey,
          ...(minted.userEmail ? { email: minted.userEmail } : {}),
          ...(minted.userFullName ? { displayName: minted.userFullName } : {}),
          providerSpecificData: {
            ...(credentials?.providerSpecificData || {}),
            apiBaseUrl: resolveApiBase(credentials),
            baseUrl: resolveApiBase(credentials),
          },
        };
      } catch (err) {
        log?.warn?.("TOKEN", `Muse re-mint failed: ${err.message}`);
        return { error: "unrecoverable_refresh_error", message: MUSE_REAUTH_MESSAGE };
      }
    });
  }

  needsRefresh(credentials) {
    // expiresAt is telemetry-only for Muse; never proactively refresh.
    void credentials;
    return false;
  }
}

export default MuseExecutor;
