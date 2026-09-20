import crypto from "node:crypto";
import { DefaultExecutor } from "./default.js";
import { resolveSessionId, generateOpencodeSessionId } from "../utils/sessionManager.js";
import { detectClientTool } from "../utils/clientDetector.js";
import { sanitizeConsoleResponsesToolSchemas } from "../utils/jsonSchema.js";


const MAX_TOOL_NAME_LEN = 128;

// Conversation-stable session: same (sessionId, clientTool) pair always hashes
// to the same ses_ id, so upstream sees one session per conversation.
function stableOpencodeSessionId(sessionId, clientTool) {
  const digest = crypto.createHash("sha256")
    .update(`opencode-go\0${clientTool || "generic"}\0${sessionId}`)
    .digest("hex")
    .slice(0, 32);
  return `ses_${digest}`;
}

// Last line of defense for native Responses clients (sourceFormat === targetFormat
// skips translation): coerce items in place so malformed tool payloads 400 here
// with a clear shape instead of upstream as InputValidationError.
// Port of eafac37d: strip prior-turn reasoning items — Muse Spark contributor
// models route to an upstream Console backend where encrypted_content cannot be
// validated across rotated accounts or sessions, causing 400
// "reasoning encrypted_content was not issued to this caller".
function clampResponsesCallId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  return id ? id.slice(0, 256) : "call_unknown";
}

function coerceResponsesArguments(value) {
  return typeof value === "string" ? value : JSON.stringify(value ?? {});
}

function coerceResponsesOutput(value) {
  return typeof value === "string" ? value : JSON.stringify(value ?? null);
}

function sanitizeResponsesItems(body) {
  if (!Array.isArray(body.input)) return;
  body.input = body.input.filter((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return true;
    if (item.type === "reasoning") return false;
    delete item.encrypted_content;
    delete item.reasoning_encrypted_content;
    if (item.type === "function_call") {
      if (!item.name || typeof item.name !== "string" || item.name.trim() === "") return false;
      item.name = item.name.trim().slice(0, MAX_TOOL_NAME_LEN);
      item.call_id = clampResponsesCallId(item.call_id);
      item.arguments = coerceResponsesArguments(item.arguments);
      return true;
    }
    if (item.type === "function_call_output") {
      item.call_id = clampResponsesCallId(item.call_id);
      item.output = coerceResponsesOutput(item.output);
      return true;
    }
    return true;
  });
}

// Provider-scoped OpenCode Go session injection: preserve the supplied
// x-opencode-session header or mint one ses_ id per logical request (stable
// across retries via request-scoped ctx). Auth/URL behavior stays DefaultExecutor.
export class OpenCodeGoExecutor extends DefaultExecutor {
  constructor() {
    super("opencode-go");
  }

  transformRequest(model, body) {
    // OpenCode Go Responses wire rejects Chat Completions reasoning_effort.
    if (Array.isArray(body?.input) || String(model).startsWith("muse-spark-")) {
      delete body.reasoning_effort;
    }
    // Only Responses models reach Console's RE2 schema validator.
    if (Array.isArray(body?.input)) {
      sanitizeConsoleResponsesToolSchemas(body);
      sanitizeResponsesItems(body);
    }
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
