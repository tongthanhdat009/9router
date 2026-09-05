import { DefaultExecutor } from "./default.js";
import { resolveSessionId, generateOpencodeSessionId, normalizeOpencodeSessionId } from "../utils/sessionManager.js";

// Provider-scoped OpenCode Go session injection: preserve the supplied
// x-opencode-session header or mint one ses_ id per logical request (stable
// across retries via request-scoped ctx). Auth/URL behavior stays DefaultExecutor.
export class OpenCodeGoExecutor extends DefaultExecutor {
  constructor() {
    super("opencode-go");
  }

  deriveRequestContext(body, credentials) {
    return {
      sessionId: normalizeOpencodeSessionId(resolveSessionId({
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
    headers["x-opencode-session"] = lower["x-opencode-session"] || ctx.sessionId || generateOpencodeSessionId();
    return headers;
  }
}
