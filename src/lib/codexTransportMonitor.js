import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./dataDir.js";

function monitorFile() {
  return process.env.CODEX_TRANSPORT_LOG_FILE || path.join(DATA_DIR, "logs", "codex-transport.jsonl");
}

function stringOrNull(value) {
  return typeof value === "string" ? value.slice(0, 200) : null;
}

export function monitorCodexTransport(event, details = {}) {
  try {
    if (process.env.ENABLE_CODEX_TRANSPORT_LOG !== "1") return false;
    const file = monitorFile();
    const record = {
      timestamp: new Date().toISOString(),
      pid: process.pid,
      event,
      transport: stringOrNull(details.transport),
      // Error messages can contain upstream detail; retain only that a reason exists.
      reason: details.reason == null ? null : "[redacted]",
      errorName: stringOrNull(details.errorName),
      framesEmitted: Number.isFinite(details.framesEmitted) ? details.framesEmitted : null,
      attempt: Number.isFinite(details.attempt) ? details.attempt : null,
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
    return true;
  } catch {
    // Diagnostic telemetry must never affect Codex request handling.
    return false;
  }
}
