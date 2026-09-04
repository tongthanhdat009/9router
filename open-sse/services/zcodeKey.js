import { proxyAwareFetch } from "../utils/proxyFetch.js";

// ZCode coding-plan API key auto-provisioning, mirroring the installed ZCode
// client's observed resolver (resources/glm/zcode.cjs createCodingPlanApiKeyResolver),
// live-verified 2026-09-04 against the real account:
//
// 1. POST https://api.z.ai/api/auth/z/login { token: <OAuth JWT> }
//    -> data.access_token (Z.ai business token).
// 2. GET https://api.z.ai/api/biz/customer/getCustomerInfo with
//    Authorization: Bearer <business token> -> organizations[0]/projects[0].
// 3. GET .../v1/organization/{org}/projects/{proj}/api_keys -> find the entry
//    named "zcode-api-key"; POST { name } to create it when absent.
// 4. GET .../api_keys/copy/{apiKey} -> secretKey; final key apiKey.secretKey.
//
// Pure fetch+parse+classify: NO persistence (key rides the generic refresh-result
// PSD merge), NO timers. Lazy + reactive mint; single-flight per connection.
// Logs carry endpoint/stage names only — never token or key material.
const AUTH_URL = "https://api.z.ai/api/auth/z/login";
const HOST = "https://api.z.ai";
const KEY_NAME = "zcode-api-key";

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

function keyLog(conn, event, detail) {
  console.log("[DBG:ZCODEKEY] conn=%s event=%s detail=%s", conn, event, detail || "");
}

// Z.ai envelopes every biz call as HTTP 200 + { code, msg, data, success }.
// A logical code 401 means AUTH (expired/wrong token) — never "no plan".
async function bizJson(response) {
  const payload = await response.json().catch(() => null);
  if (!response.ok) return { transport: response.status, payload };
  const code = payload?.code;
  if (code === 401 || code === "401") {
    throw coded("coding_plan_auth_failed", 401, false, "zcode: business token rejected (code 401)");
  }
  if (code !== undefined && code !== null && code !== 0 && code !== 200 && code !== "0" && code !== "200") {
    const err = new Error("zcode business error (" + code + ")");
    err.code = code;
    err.payload = payload;
    throw err;
  }
  return { transport: 200, data: payload?.data ?? null, payload };
}

async function fetchJson(url, init, proxyOptions) {
  return proxyAwareFetch(url, { ...init, signal: AbortSignal.timeout(10000) }, proxyOptions);
}

// Step 1 of the observed flow: exchange the stored OAuth JWT for a Z.ai
// business token. Body carries the RAW token (no Bearer prefix).
async function resolveBizToken(oauthToken, proxyOptions) {
  const response = await fetchJson(AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: oauthToken }),
  }, proxyOptions);
  const biz = await bizJson(response);
  if (biz.transport !== 200) {
    const status = biz.transport || 500;
    throw coded("coding_plan_auth_failed", status, status === 429 || status >= 500, "zcode: /api/auth/z/login failed (" + status + ")");
  }
  const token = String(biz.data?.access_token ?? biz.data?.accessToken ?? "").trim();
  if (!token) throw coded("coding_plan_auth_failed", 200, false, "zcode: biz token response missing access_token");
  return token;
}

// Step 2: first organization + first project. The observed client prefers
// localized default names then falls back to first/first; live account has one.
function pickOrgProject(customer) {
  const orgs = customer?.organizations ?? [];
  const org = orgs[0];
  const project = org?.projects?.[0];
  if (!org?.organizationId || !project?.projectId) return null;
  return { organizationId: org.organizationId, projectId: project.projectId };
}

async function mintOnce(credentials, proxyOptions = null) {
  const oauthToken = credentials?.accessToken;
  if (!oauthToken) {
    throw coded("coding_plan_auth_failed", 401, false, "zcode: no access token for key mint");
  }
  const headersFor = (biz) => ({ Authorization: "Bearer " + biz, "Content-Type": "application/json" });
  let bizToken;
  try {
    bizToken = await resolveBizToken(oauthToken, proxyOptions);
  } catch (e) {
    if (e.code === "coding_plan_auth_failed") throw e;
    if (typeof e.code === "number") {
      const status = e.code;
      throw coded("coding_plan_auth_failed", status, status === 429 || status >= 500, "zcode: biz login returned code " + status);
    }
    throw coded("coding_plan_auth_failed", 500, true, "zcode: biz login transport failed");
  }
  const customerResp = await fetchJson(HOST + "/api/biz/customer/getCustomerInfo", { headers: headersFor(bizToken) }, proxyOptions);
  const customerBiz = await bizJson(customerResp);
  const org = pickOrgProject(customerBiz.data);
  if (!org) {
    const hay = JSON.stringify(customerBiz.payload ?? "").toLowerCase();
    if (hay.includes("not_entitled") || hay.includes("no coding plan") || hay.includes("unsubscribed")) {
      throw coded("coding_plan_not_entitled", 200, false, "zcode: account has no coding plan entitlement");
    }
    if (hay.includes("not_connected") || hay.includes("unbound") || hay.includes("unlinked")) {
      throw coded("coding_plan_not_connected", 200, false, "zcode: coding plan not connected to this account");
    }
    throw coded("coding_plan_not_connected", 200, false, "zcode: unable to resolve organization and project");
  }
  // Steps 3-4: find (or create) the named key, then read its secret copy.
  const base = HOST + "/api/biz/v1/organization/" + encodeURIComponent(org.organizationId) + "/projects/" + encodeURIComponent(org.projectId) + "/api_keys";
  const listResp = await fetchJson(base, { headers: headersFor(bizToken) }, proxyOptions);
  const listBiz = await bizJson(listResp);
  let entry = (Array.isArray(listBiz.data) ? listBiz.data : []).find((d) => d?.name === KEY_NAME);
  if (!entry) {
    const createResp = await fetchJson(base, { method: "POST", headers: headersFor(bizToken), body: JSON.stringify({ name: KEY_NAME }) }, proxyOptions);
    const createBiz = await bizJson(createResp);
    entry = createBiz.data && typeof createBiz.data === "object" ? createBiz.data : null;
  }
  const apiKey = String(entry?.apiKey ?? "").trim();
  if (!apiKey) throw coded("coding_plan_not_connected", 200, false, "zcode: API key response missing apiKey");
  const copyResp = await fetchJson(base + "/copy/" + encodeURIComponent(apiKey), { headers: headersFor(bizToken) }, proxyOptions);
  const copyBiz = await bizJson(copyResp);
  const secret = String(copyBiz.data?.secretKey ?? "").trim();
  // Observed final shape: apiKey.secretKey (49 chars on the live account).
  return { key: secret ? apiKey + "." + secret : apiKey, path: secret ? "api_keys/zcode-api-key+copy" : "api_keys/zcode-api-key" };
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
