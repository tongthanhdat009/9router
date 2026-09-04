import crypto from "node:crypto";
import { deriveSessionId } from "./sessionManager.js";

// Shared ZCode upstream identity (approved contract: static set + fresh UUIDs +
// stable session on EVERY zcode upstream call — inference, ticket, billing).
// Leaf module: executor, off-peak, and usage clients all import from here,
// so none of them import each other (no cycles).
export const ZCODE_IDENTITY_HEADERS = Object.freeze({
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

export function zcodeRequestHeaders(sessionId) {
  const headers = {
    ...ZCODE_IDENTITY_HEADERS,
    "X-Request-Id": crypto.randomUUID(),
    "X-Query-Id": crypto.randomUUID(),
    "X-ZCode-Trace-Id": crypto.randomUUID(),
  };
  if (sessionId) headers["X-Session-Id"] = sessionId;
  return headers;
}

// ponytail: executor channel state wins when present; usage clients fall back
// to the stable per-connection id. Promote to request-scoped only if a caller
// ever needs a fresher session than the connection one.
export function zcodeSessionId(credentials) {
  return credentials?.__zcodeChannel?.sessionId || deriveSessionId(credentials?.connectionId);
}
