import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./dataDir.js";

function monitorFile() {
  return process.env.OAUTH_REFRESH_MONITOR_FILE || path.join(DATA_DIR, "logs", "oauth-refresh-monitor.jsonl");
}

const SENSITIVE_KEY = /^(accessToken|refreshToken|idToken|token|cookie|authorization|email|secret|password|header)$/i;

function safeValue(value, key = "") {
  if (SENSITIVE_KEY.test(key)) return value == null ? value : "[redacted]";
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.slice(0, 200);
  if (Array.isArray(value)) return value.map((item) => safeValue(item));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, safeValue(item, name)]));
  }
  return String(value);
}

export function monitorOAuthRefresh(event, details = {}) {
  try {
    const file = monitorFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ timestamp: new Date().toISOString(), pid: process.pid, event, provider: details.provider ?? null, connectionId: details.connectionId ?? null, ...safeValue(details) })}\n`);
  } catch {
    // Diagnostic telemetry must never affect OAuth or request handling.
  }
}

monitorOAuthRefresh("PROCESS_INIT", { dataDir: DATA_DIR, cwd: process.cwd(), execPath: process.execPath });
