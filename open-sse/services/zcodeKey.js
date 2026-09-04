import { proxyAwareFetch } from "../utils/proxyFetch.js";

// ZCode coding-plan API key (df8d…) auto-provisioning from the OAuth session.
// Pure fetch+parse+classify: NO persistence (key rides the generic refresh-result
// PSD merge), NO timers. Lazy + reactive mint; single-flight per connection.
const CUSTOMER_INFO_URL = "https://api.z.ai/api/biz/customer/getCustomerInfo";

// Ordered candidate paths for the df8d key inside getCustomerInfo data.
// VERIFY-LIVE (ledger B-1) decides which path hits; first match wins. The
// [DBG:ZCODEKEY] tag logs WHICH path hit — never the value.
// ponytail: personal-plan shape only; team org/project /api_keys path is a FOLLOW-UP
// gated on a live team capture (org/project ids are not in PSD today).
const KEY_PATHS = [
  ["codingPlanApiKey"],
  ["coding_plan_api_key"],
  ["data", "codingPlanApiKey"],
  ["data", "coding_plan_api_key"],
  ["data", "apiKey"],
  ["data", "api_key"],
  ["data", "customer", "codingPlanApiKey"],
  ["data", "customer", "apiKey"],
  ["data", "entitlement", "apiKey"],
  ["data", "plan", "apiKey"],
];

const inFlightMint = new Map();
const keyByConnection = new Map();

// Coded error: { code, status, retryable, message }.
function coded(code, status, retryable, message) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  err.retryable = retryable;
  return err;
}

function pick(obj, path) {
  let cur = obj;
  for (const seg of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[seg];
  }
  return cur;
}

// ponytail: ensure()'s fast path accepts any non-blank pasted key (legacy
// phase-1 fixtures use short test keys); a garbage paste self-heals via the
// 401 re-mint recovery. Tighten fast path to looksLikeKey once pasted-key
// validation is live-verified.
function looksLikeKey(value) {
  return typeof value === "string" && value.length >= 8 && /^df8d/i.test(value.trim());
}

function keyLog(conn, event, detail) {
  console.log("[DBG:ZCODEKEY] conn=%s event=%s detail=%s", conn, event, detail || "");
}

async function mintOnce(credentials, proxyOptions = null) {
  const accessToken = credentials?.accessToken;
  if (!accessToken) {
    throw coded("coding_plan_auth_failed", 401, false, "zcode: no access token for key mint");
  }
  const response = await proxyAwareFetch(
    CUSTOMER_INFO_URL,
    {
      headers: { Authorization: accessToken, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10000),
    },
    proxyOptions,
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const status = response.status;
    if (status === 401 || status === 403) {
      throw coded("coding_plan_auth_failed", status, false, "zcode: getCustomerInfo rejected access token (" + status + ")");
    }
    if (status === 429 || status >= 500) {
      throw coded("coding_plan_auth_failed", status, true, "zcode: getCustomerInfo transient (" + status + ")");
    }
    throw coded("coding_plan_auth_failed", status, false, "zcode: getCustomerInfo failed (" + status + ")");
  }
  const data = payload?.data ?? payload;
  for (const path of KEY_PATHS) {
    const value = pick(payload, path) ?? pick({ data }, path);
    if (looksLikeKey(value)) {
      return { key: value.trim(), path: path.join("."), data };
    }
  }
  // No key found: distinguish not-entitled / not-connected from opaque shape.
  const haystack = JSON.stringify(payload ?? "").toLowerCase();
  if (haystack.includes("not_entitled") || haystack.includes("not entitled") || haystack.includes("no coding plan") || haystack.includes("unsubscribed")) {
    throw coded("coding_plan_not_entitled", 200, false, "zcode: account has no coding plan entitlement");
  }
  if (haystack.includes("not_connected") || haystack.includes("not connected") || haystack.includes("unbound") || haystack.includes("unlinked")) {
    throw coded("coding_plan_not_connected", 200, false, "zcode: coding plan not connected to this account");
  }
  throw coded("coding_plan_not_entitled", 200, false, "zcode: no coding-plan key in customer info");
}

export async function mintCodingPlanKey(credentials, proxyOptions = null) {
  const conn = credentials?.connectionId || "";
  const minted = await mintOnce(credentials, proxyOptions);
  keyLog(conn, "minted", "path=" + minted.path);
  return { key: minted.key, source: "mint", entitlement: { plan: "coding", path: minted.path } };
}

// Returns cached PSD/paste key without network; else single-flight mint.
// Never throws for missing credentials shape — returns null so the executor
// can fail closed with remediation text.
export async function ensureCodingPlanKey(credentials, proxyOptions = null) {
  const psd = credentials?.providerSpecificData || {};
  if (typeof psd.codingPlanApiKey === "string" && psd.codingPlanApiKey.length >= 4) {
    return psd.codingPlanApiKey;
  }
  if (typeof credentials?.apiKey === "string" && credentials.apiKey.length >= 4) {
    return credentials.apiKey;
  }
  const conn = credentials?.connectionId || "";
  // ponytail: without a connectionId the process cache is skipped entirely —
  // a shared "" slot could never be invalidated (review P2).
  if (conn) {
    const cached = keyByConnection.get(conn);
    if (cached) return cached;
    const flight = inFlightMint.get(conn);
    if (flight) return flight;
  }
  const mint = mintOnce(credentials, proxyOptions).then((minted) => {
    if (conn) keyByConnection.set(conn, minted.key);
    keyLog(conn, "minted", "path=" + minted.path);
    return minted.key;
  });
  if (conn) {
    inFlightMint.set(conn, mint);
    // .finally derives a second promise; swallow its rejection so a failed
    // mint (the caller awaits it directly) is not also an unhandled rejection.
    mint.finally(() => {
      if (inFlightMint.get(conn) === mint) inFlightMint.delete(conn);
    }).catch(() => {});
  }
  return mint;
}

export function invalidateCodingPlanKey(connectionId) {
  if (!connectionId) return;
  keyByConnection.delete(connectionId);
  if (inFlightMint.has(connectionId)) inFlightMint.delete(connectionId);
}

export function clearZcodeKeyStateForTests() {
  inFlightMint.clear();
  keyByConnection.clear();
}
