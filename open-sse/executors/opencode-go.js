import crypto from "crypto";
import { DefaultExecutor } from "./default.js";
import { PROVIDERS } from "../config/providers.js";
import { resolveSessionId } from "../utils/sessionManager.js";

function generateSessionId() {
  return `ses_${crypto.randomUUID().replace(/-/g, "")}`;
}

function toGoSession(id) {
  const stripped = String(id || "").replace(/^ses_/, "").replace(/-/g, "");
  return stripped ? `ses_${stripped}` : null;
}

// Provider-scoped OpenCode Go session injection: preserve the supplied
// x-opencode-session header or mint one ses_ id per logical request (stable
// across retries via request-scoped ctx). Auth/URL behavior stays DefaultExecutor.
export class OpenCodeGoExecutor extends DefaultExecutor {
  constructor() {
    super("opencode-go");
    this.config = PROVIDERS["opencode-go"];
  }

  deriveRequestContext(body, credentials) {
    return {
      sessionId: toGoSession(resolveSessionId({
        headers: credentials?.rawHeaders,
        body,
        connectionId: credentials?.connectionId,
        scope: "opencode-go",
      })),
    };
  }

  buildHeaders(credentials, stream = true, url, model, ctx = {}) {
    const headers = super.buildHeaders(credentials, stream, url, model);
    const raw = credentials?.rawHeaders || {};
    const lower = {};
    for (const [k, v] of Object.entries(raw)) lower[k.toLowerCase()] = v;
    headers["x-opencode-session"] = lower["x-opencode-session"] || ctx.sessionId || generateSessionId();
    return headers;
  }
}
