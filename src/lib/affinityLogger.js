import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./dataDir.js";
import { getSettings } from "./localDb.js";

const SENSITIVE_KEY = /^(access_token|refresh_token|id_token|access_token_secret|token_type|bearer|api_key|apikey|accessToken|refreshToken|idToken|token|cookie|authorization|email|secret|password|header|prompt|messages|prompt_cache_key|promptCacheKey|previous_response_id|previousResponseId|thread_id|threadId|session|sessionId|x-session-id|session-id|session_id|x-amp-thread-id|x-client-request-id|x-claude-code-session-id|x-session-affinity|x-mux-workspace-id|x-opencode-session)$/i;

function safeValue(value, key = "") {
  if (SENSITIVE_KEY.test(key)) return value == null ? value : "[redacted]";
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.slice(0, 200);
  if (Array.isArray(value)) return value.map((item) => safeValue(item));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, safeValue(item, name)]));
  return String(value);
}

async function enabled() {
  if (process.env.ENABLE_AFFINITY_LOG === "1") return true;
  try { return (await getSettings()).enableObservability === true; } catch { return false; }
}

let dirEnsured = false;

export async function logAffinity(event, details = {}) {
  try {
    if (!(await enabled())) return false;
    const file = process.env.AFFINITY_LOG_FILE || path.join(DATA_DIR, "logs", "affinity.jsonl");
    if (!dirEnsured) {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      dirEnsured = true;
    }
    const line = `${JSON.stringify({ timestamp: new Date().toISOString(), pid: process.pid, event, ...safeValue(details) })}\n`;
    await fs.promises.appendFile(file, line);
    return true;
  } catch { return false; }
}

export { safeValue as safeAffinityLogValue };
