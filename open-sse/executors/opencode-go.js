import crypto from "node:crypto";
import { DefaultExecutor } from "./default.js";
import { resolveSessionId, generateOpencodeSessionId } from "../utils/sessionManager.js";
import { detectClientTool } from "../utils/clientDetector.js";
import { sanitizeConsoleResponsesToolSchemas } from "../utils/jsonSchema.js";

// Conversation-stable session: same (sessionId, clientTool) pair always hashes
// to the same ses_ id, so upstream sees one session per conversation.
function stableOpencodeSessionId(sessionId, clientTool) {
  const digest = crypto.createHash("sha256")
    .update(`opencode-go\0${clientTool || "generic"}\0${sessionId}`)
    .digest("hex")
    .slice(0, 32);
  return `ses_${digest}`;
}

// Provider-scoped OpenCode Go session injection: preserve the supplied
// x-opencode-session header or mint one ses_ id per logical request (stable
// across retries via request-scoped ctx). Auth/URL behavior stays DefaultExecutor.
export class OpenCodeGoExecutor extends DefaultExecutor {
  constructor() {
    super("opencode-go");
  }

  transformRequest(model, body) {
    // OpenCode Go Muse reasons automatically but rejects client-controlled effort.
    if (String(model).startsWith("muse-spark-")) {
      delete body.reasoning;
      delete body.reasoning_effort;
    }
    // Only Responses models reach Console's RE2 schema validator.
    if (Array.isArray(body?.input)) sanitizeConsoleResponsesToolSchemas(body);
    return super.transformRequest(model, body);
  }

  deriveRequestContext(body, credentials) {
    const rawHeaders = credentials?.rawHeaders || {};
    const sessionId = resolveSessionId({
      headers: rawHeaders,
      body,
      connectionId: credentials?.connectionId,
      scope: "opencode-go",
    });
    if (!sessionId) return { sessionId: null };
    const clientTool = detectClientTool(rawHeaders, body);
    return { sessionId: stableOpencodeSessionId(sessionId, clientTool) };
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
