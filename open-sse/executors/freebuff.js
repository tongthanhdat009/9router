import crypto from "node:crypto";
import { DefaultExecutor } from "./default.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";

const AUTH_BASE = "https://www.codebuff.com";
const SESSION_PATH = "/api/v1/freebuff/session";
const ADMISSION_URL = AUTH_BASE + SESSION_PATH + "/admission";
const SESSION_URL = AUTH_BASE + SESSION_PATH;
const ADMISSION_TIMEOUT_MS = 20000;
const HEARTBEAT_MS = 30000;
const HEARTBEAT_JITTER_MS = 2000;
const SESSION_SAFETY_MS = 60000;
const GRACE_MS = 30 * 60 * 1000;
const connectionClients = new Map();

async function lifecycleFetch(url, options, proxyOptions, timeoutMs) {
  const connectCtrl = new AbortController();
  const connectTimer = setTimeout(() => connectCtrl.abort(new Error("fetch connect timeout")), timeoutMs);
  const mergedSignal = options.signal ? AbortSignal.any([options.signal, connectCtrl.signal]) : connectCtrl.signal;
  try {
    return await proxyAwareFetch(url, { ...options, signal: mergedSignal }, proxyOptions);
  } catch (error) {
    // Caller abort must keep its AbortError identity (chatCore maps it to 499);
    // a connect-timeout abort becomes a plain error so it surfaces as 502, not 499.
    if (connectCtrl.signal.aborted && !options.signal?.aborted) throw new Error("fetch connect timeout");
    throw error;
  } finally {
    clearTimeout(connectTimer);
  }
}

function stableClientId(credentials) {
  const psd = credentials?.providerSpecificData || {};
  if (psd.clientSessionId) return psd.clientSessionId;
  const key = credentials?.connectionId || "anonymous";
  if (!connectionClients.has(key)) connectionClients.set(key, crypto.randomUUID());
  return connectionClients.get(key);
}
// ─── Free-session manager (module state) ────────────────────────────────────
//
// Upstream contract (docs/plans/2026-09-22-freebuff-free-mode-note.md, verified
// @ bfe8408): POST {AUTH_BASE}/api/v1/freebuff/session/admission admits a free
// session; GET /api/v1/freebuff/session (x-freebuff-instance-id +
// x-freebuff-compact-session) is the 30s compact heartbeat/refresh; DELETE
// releases. A session is servable while active OR ended-with-instanceId (30min
// grace); 'superseded' is terminal. Only a sha256 fingerprint of the access
// token is ever stored — never the raw token.
const BUFFY_OPENINGS = {
  base2: "You are Buffy, the strategic coding assistant.",
  base3: "You are Buffy, the coding agent behind Codebuff.",
};
// Upstream chat/session gate, endsTheSession:true rows only (wire contract:
// /mnt/ssd-250gb/freebuff common/src/types/freebuff-session.ts:1200-1224 @ bfe8408).
// A chat rejection is the gate ONLY when the body's error code AND the HTTP
// status BOTH match; endsTheSession:false codes (session_limit_reached/409,
// waiting_room_queued/429, model_unavailable/410) leave the seat alive.
const TERMINAL_GATE_STATUS = {
  waiting_room_required: 428,
  session_expired: 410,
  session_superseded: 409,
  session_model_mismatch: 409,
};

// Verified per-model free roots (free-agents.ts:166-185,418-447,530-535).
export const FREE_ROOT_BY_MODEL = {
  "z-ai/glm-5.3-flash": "base3-free-glm-5-3-flash",
  "openai/gpt-5.6-luna": "base3-free-luna",
  "mimo/mimo-v2.5": "base3-free-mimo",
  "upstage/solar-pro4": "base3-free-solar-pro4",
  "google/gemini-3.8-flash": "base3-free-gemini-3-8-flash",
  "deepseek/deepseek-v4.1-flash": "base2-free-deepseek-v4-1-flash",
};

export class FreebuffSessionError extends Error {
  constructor(status, bodyText, retryAfterMs) {
    super("FreeBuff session admission failed with HTTP " + status);
    this.name = "FreebuffSessionError";
    this.status = status;
    this.bodyText = bodyText;
    this.retryAfterMs = retryAfterMs;
  }
}

const freeSessions = new Map(); // connectionId -> { fp, model, instanceId, expiresAt, status, graceUntil?, heartbeatTimer }
const freeSessionInFlight = new Map(); // connectionId -> admission promise (single-flight)

function tokenFingerprint(accessToken) {
  return crypto.createHash("sha256").update(String(accessToken || "")).digest("hex").slice(0, 12);
}

function sessionAuthHeaders(credentials) {
  return { Authorization: `Bearer ${credentials?.accessToken}` };
}

function timeZoneHeader() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function parseRetryAfterMs(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function purgeFreeSession(key, log, reason) {
  const entry = freeSessions.get(key);
  if (!entry) return;
  if (entry.heartbeatTimer) {
    clearInterval(entry.heartbeatTimer);
    entry.heartbeatTimer = undefined;
  }
  freeSessions.delete(key);
  log?.debug?.("FREEBUFF", `free session purged (${reason}) conn=${key}`);
}

function freeSessionServable(entry) {
  if (!entry) return false;
  const now = Date.now();
  if (entry.status === "ended") return entry.graceUntil > now;
  return entry.expiresAt - SESSION_SAFETY_MS > now;
}

function releaseFreeSession(entry, credentials, log) {
  // Fire-and-forget DELETE; expect {status:"ended"}. Never blocks admission.
  proxyAwareFetch(SESSION_URL, {
    method: "DELETE",
    headers: { ...sessionAuthHeaders(credentials), "x-freebuff-instance-id": entry.instanceId, "x-freebuff-compact-session": "1" },
    signal: AbortSignal.timeout(ADMISSION_TIMEOUT_MS),
  }, null).catch((error) => {
    log?.debug?.("FREEBUFF", `free session release failed: ${error?.message || error}`);
  });
}

async function heartbeatFreeSession(entry, credentials, log, key) {
  try {
    const response = await proxyAwareFetch(SESSION_URL, {
      method: "GET",
      headers: { ...sessionAuthHeaders(credentials), "x-freebuff-instance-id": entry.instanceId, "x-freebuff-compact-session": "1" },
      signal: AbortSignal.timeout(ADMISSION_TIMEOUT_MS),
    }, null);
    if (!response.ok) {
      // Upstream gone-signal: GET /session 404 -> callFreebuffSession synthesizes {status:'none'}
      // (freebuff-session-api.ts) = terminal. Other non-OK (408/429/5xx/auth) are transient: keep.
      if (response.status === 404) purgeFreeSession(key, log, `seat gone HTTP ${response.status}`);
      return;
    }
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { return; }
    if (data?.status === "active" && data?.expiresAt) {
      const expiresAt = Date.parse(data.expiresAt);
      if (!Number.isNaN(expiresAt)) entry.expiresAt = expiresAt;
      // Only overwrite present fields: absent fields carry forward, never blank.
      if (data.freebucks !== undefined) entry.freebucks = data.freebucks;
      if (data.remainingMs !== undefined) entry.remainingMs = data.remainingMs;
      if (data.accessTier !== undefined) entry.accessTier = data.accessTier;
      if (data.admittedAt !== undefined) entry.admittedAt = data.admittedAt;
    } else if (data?.status === "ended") {
      entry.status = "ended";
      entry.graceUntil = entry.expiresAt + GRACE_MS;
      log?.debug?.("FREEBUFF", `free session ended upstream; grace until ${new Date(entry.graceUntil).toISOString()}`);
    } else if (data?.status === "superseded" || data?.status === "none") {
      purgeFreeSession(key, log, data.status);
    }
    if (freeSessions.get(key) === entry && entry.status === "ended" && entry.graceUntil <= Date.now()) {
      purgeFreeSession(key, log, "grace expired");
    }
  } catch (error) {
    log?.debug?.("FREEBUFF", `free session heartbeat failed: ${error?.message || error}`);
  }
}

function startFreeSessionHeartbeat(entry, credentials, log, key) {
  const period = HEARTBEAT_MS + Math.floor(Math.random() * (2 * HEARTBEAT_JITTER_MS + 1)) - HEARTBEAT_JITTER_MS;
  const timer = setInterval(() => { heartbeatFreeSession(entry, credentials, log, key); }, period);
  timer.unref?.();
  entry.heartbeatTimer = timer;
}

async function admitFreeSession(credentials, model, log, key) {
  const response = await lifecycleFetch(ADMISSION_URL, {
    method: "POST",
    headers: {
      ...sessionAuthHeaders(credentials),
      "x-fb-timezone": timeZoneHeader(),
      "x-freebuff-first-tab-discount": "0",
      "x-freebuff-model": model,
      "x-freebuff-wallet-spend-limit": "0",
    },
  }, null, ADMISSION_TIMEOUT_MS);
  const text = await response.text();
  if (!response.ok) {
    throw new FreebuffSessionError(response.status, text, parseRetryAfterMs(response.headers?.get?.("retry-after")));
  }
  let data;
  try { data = JSON.parse(text); } catch {
    throw new FreebuffSessionError(502, text, null);
  }
  const expiresAt = Date.parse(data?.expiresAt);
  if (!data?.instanceId || Number.isNaN(expiresAt) || (data?.status !== "active" && data?.status !== "ended")) {
    throw new FreebuffSessionError(502, text, null);
  }
  const entry = { fp: tokenFingerprint(credentials?.accessToken), model, instanceId: data.instanceId, expiresAt, status: data.status };
  // Preserve admission metadata (official mergeCompactActiveSession carries it the same way).
  if (data.freebucks !== undefined) entry.freebucks = data.freebucks;
  if (data.remainingMs !== undefined) entry.remainingMs = data.remainingMs;
  if (data.accessTier !== undefined) entry.accessTier = data.accessTier;
  if (data.admittedAt !== undefined) entry.admittedAt = data.admittedAt;
  if (entry.status === "ended") entry.graceUntil = entry.expiresAt + GRACE_MS;
  freeSessions.set(key, entry);
  startFreeSessionHeartbeat(entry, credentials, log, key);
  log?.debug?.("FREEBUFF", `free session admitted model=${model} conn=${key}`);
  return entry;
}

// One live free session per connectionId. Concurrent callers share a single
// admission (single-flight); a different model or account on the same
// connection releases/purges the previous session first.
export async function ensureFreeSession(credentials, model, log) {
  // Never key a seat by a shared fallback: without the real account identity
  // two unrelated accounts would thrash one upstream seat (single model-bound
  // slot per account). execute() converts this into the 400 contract.
  if (!credentials?.connectionId) {
    throw new FreebuffSessionError(400, JSON.stringify({ error: { message: "FreeBuff free mode requires a provider connection (connectionId missing); refusing to share an anonymous free session." } }), null);
  }
  const key = credentials.connectionId;
  const fp = tokenFingerprint(credentials?.accessToken);
  for (;;) {
    const entry = freeSessions.get(key);
    if (entry && entry.fp === fp && entry.model === model && freeSessionServable(entry)) return entry;
    const pending = freeSessionInFlight.get(key);
    if (pending) {
      await pending;
      continue;
    }
    if (entry && entry.fp !== fp) purgeFreeSession(key, log, "account changed");
    else if (entry) {
      if (freeSessionServable(entry)) releaseFreeSession(entry, credentials, log);
      purgeFreeSession(key, log, entry.model !== model ? "model switched" : "expired");
    }
    const admission = admitFreeSession(credentials, model, log, key).finally(() => freeSessionInFlight.delete(key));
    freeSessionInFlight.set(key, admission);
    return admission;
  }
}

export function _resetSessionsForTests() {
  for (const entry of freeSessions.values()) {
    if (entry.heartbeatTimer) clearInterval(entry.heartbeatTimer);
  }
  freeSessions.clear();
  freeSessionInFlight.clear();
}

// Fire-and-forget FINISH on an independent timeout signal: the caller signal
// may already be aborted (client disconnect), which must not prevent closing
// the upstream run. Status vocabulary matches the official contract:
// 'completed' | 'failed' | 'cancelled'.
function postFinish({ runId, status, errorMessage, headers, proxyOptions, timeoutMs, log }) {
  const body = JSON.stringify({
    action: "FINISH",
    runId,
    status,
    totalSteps: 1,
    directCredits: 0,
    totalCredits: 0,
    errorMessage: errorMessage || null,
    steps: [],
  });
  let signal;
  try {
    signal = AbortSignal.timeout(timeoutMs);
  } catch { signal = undefined; }
  proxyAwareFetch(AUTH_BASE + "/api/v1/agent-runs", {
    method: "POST",
    headers,
    body,
    ...(signal ? { signal } : {}),
  }, proxyOptions).catch((finishError) => {
    log?.debug?.("FREEBUFF", `FINISH ${status} failed: ${finishError?.message || finishError}`);
  });
}

// Wrap the upstream body so FINISH fires on terminal stream state, not on
// headers-received (super.execute resolves as soon as headers arrive for
// stream:true). Bytes pass through unchanged; FINISH fires exactly once.
function wrapWithTerminalFinish(response, { runId, headers, proxyOptions, timeoutMs, log, callerSignal }) {
  const original = response.body;
  if (!original) {
    postFinish({ runId, status: "completed", headers, proxyOptions, timeoutMs, log });
    return response;
  }
  let settled = false;
  let reader = null;
  const settle = (status, errorMessage) => {
    if (settled) return;
    settled = true;
    postFinish({ runId, status, errorMessage, headers, proxyOptions, timeoutMs, log });
  };
  const wrapped = new ReadableStream({
    async start(controller) {
      reader = original.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
        controller.close();
        settle("completed");
      } catch (error) {
        const cancelled = error?.name === "AbortError" || callerSignal?.aborted;
        settle(cancelled ? "cancelled" : "failed", String(error?.message || error).slice(0, 5000));
        controller.error(error);
      } finally {
        try { reader.releaseLock(); } catch { /* already released */ }
      }
    },
    async cancel(reason) {
      settle(callerSignal?.aborted ? "cancelled" : "failed", callerSignal?.aborted ? "Request aborted" : "Response body cancelled");
      try { await reader?.cancel(reason); } catch { /* upstream already closed */ }
    },
  });
  return new Response(wrapped, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export class FreebuffExecutor extends DefaultExecutor {
  constructor() {
    super("freebuff");
  }

  transformRequest(model, body, stream, credentials) {
    const transformed = super.transformRequest(model, { ...body }, stream, credentials);
    const supplied = transformed.codebuff_metadata && typeof transformed.codebuff_metadata === "object"
      ? transformed.codebuff_metadata
      : {};
    const instanceId = credentials?.__freebuffInstanceId;
    const freeRoot = instanceId ? FREE_ROOT_BY_MODEL[model] : null;
    delete transformed.runId;
    delete transformed.clientId;
    delete transformed.extraCodebuffMetadata;
    transformed.codebuff_metadata = {
      ...supplied,
      run_id: credentials.__freebuffRunId,
      client_id: stableClientId(credentials),
      trace_session_id: supplied.trace_session_id || body?.trace_session_id || body?.session_id || body?.conversation_id || credentials?._clientSessionId || credentials?.providerSpecificData?.traceSessionId || crypto.randomUUID(),
      cost_mode: instanceId ? "free" : (credentials?.providerSpecificData?.costMode || credentials?.connectionMetadata?.costMode || credentials?.costMode) === "free" ? "free" : "normal",
      ...(instanceId ? { freebuff_instance_id: instanceId } : {}),
    };
    if (freeRoot && Array.isArray(transformed.messages)) {
      const opening = freeRoot.startsWith("base2") ? BUFFY_OPENINGS.base2 : BUFFY_OPENINGS.base3;
      const first = transformed.messages[0];
      if (first?.role === "system") {
        const text = typeof first.content === "string" ? first.content : Array.isArray(first.content) ? first.content.map((p) => p?.text || "").join("\n") : "";
        if (!text.trimStart().startsWith(opening)) {
          transformed.messages = [{ ...first, content: opening + "\n\n" + text }, ...transformed.messages.slice(1)];
        }
      } else {
        transformed.messages = [{ role: "system", content: opening }, ...transformed.messages];
      }
    }
    transformed.provider = { ...(transformed.provider || {}), order: undefined, allow_fallbacks: false };
    return transformed;
  }


  buildHeaders(credentials, stream, url, model, ctx) {
    const headers = super.buildHeaders(credentials, stream, url, model, ctx);
    const userId = credentials?.providerSpecificData?.userId;
    if (userId) headers["x-freebuff-acting-user-id"] = userId;
    return headers;
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null, requestId = null, preparedRequest = null }) {
    const headers = this.buildHeaders(credentials, false);
    const userId = credentials?.providerSpecificData?.userId;
    const freeRoot = FREE_ROOT_BY_MODEL[model];
    const wantsFree = (credentials?.providerSpecificData?.costMode ?? "free") !== "normal" && Boolean(freeRoot);
    // Free mode requested but this model has no verified free root: actionable
    // 400, zero upstream traffic. Paid mode (costMode "normal") keeps the exact
    // legacy path below.
    if (!wantsFree && (credentials?.providerSpecificData?.costMode ?? "free") !== "normal") {
      const bodyText = JSON.stringify({
        error: {
          message: `FreeBuff free mode does not support model ${model}; supported: ${Object.keys(FREE_ROOT_BY_MODEL).join(", ")}. Use paid mode or a supported model.`,
        },
      });
      return {
        response: new Response(bodyText, { status: 400, headers: { "Content-Type": "application/json" } }),
        url: AUTH_BASE + "/api/v1/chat/completions",
        headers,
        transformedBody: {},
      };
    }
    let session = null;
    if (wantsFree) {
      try {
        session = await ensureFreeSession(credentials, model, log);
      } catch (error) {
        if (error instanceof FreebuffSessionError) {
          const responseHeaders = { "Content-Type": "text/plain; charset=utf-8" };
          if (error.retryAfterMs != null) responseHeaders["Retry-After"] = String(Math.ceil(error.retryAfterMs / 1000));
          // Surface the upstream admission failure as-is: no free->paid fallback.
          return {
            response: new Response(error.bodyText, { status: error.status, headers: responseHeaders }),
            url: ADMISSION_URL,
            headers,
            transformedBody: {},
          };
        }
        throw error;
      }
    }
    const startBody = wantsFree ? { action: "START", agentId: freeRoot, ancestorRunIds: [], ...(userId ? { userId } : {}) } : { action: "START", agentId: "9router", ...(userId ? { userId } : {}) };
    const timeoutMs = this.config?.timeoutMs || FETCH_CONNECT_TIMEOUT_MS;
    const start = await lifecycleFetch(AUTH_BASE + "/api/v1/agent-runs", {
      method: "POST",
      headers,
      body: JSON.stringify(startBody),
      signal,
    }, proxyOptions, timeoutMs);
    const startText = await start.text();
    let runId = null;
    try { runId = JSON.parse(startText)?.runId; } catch { runId = null; }
    if (!start.ok || !runId) {
      // Match the executor response contract so chatCore preserves START failures.
      return {
        response: new Response(startText, { status: start.ok ? 502 : start.status, headers: { "Content-Type": start.headers?.get?.("content-type") || "application/json" } }),
        url: AUTH_BASE + "/api/v1/agent-runs",
        headers,
        transformedBody: startBody,
      };
    }

    credentials.__freebuffRunId = runId;
    if (session) credentials.__freebuffInstanceId = session.instanceId;
    try {
      // START mints the reserved run id, so an earlier generic preparation cannot be reused.
      const result = await super.execute({ model, body, stream, credentials, signal, log, proxyOptions, requestId, preparedRequest: null });
      if (!result.response.ok) {
        // Buffer the (small) error body so a terminal chat-gate rejection can
        // purge the dead seat, then hand the caller the identical response.
        const raw = await result.response.text();
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch { /* non-JSON error body */ }
        const gateCode = typeof parsed?.error === "string" ? parsed.error : typeof parsed?.error?.code === "string" ? parsed.error.code : null;
        if (session && gateCode && TERMINAL_GATE_STATUS[gateCode] === result.response.status) {
          purgeFreeSession(credentials.connectionId, log, `chat gate ${gateCode}`);
        }
        postFinish({ runId, status: "failed", errorMessage: "Chat request failed with HTTP " + result.response.status, headers, proxyOptions, timeoutMs, log });
        return { ...result, response: new Response(raw, { status: result.response.status, statusText: result.response.statusText, headers: result.response.headers }) };
      }
      return { ...result, response: wrapWithTerminalFinish(result.response, { runId, headers, proxyOptions, timeoutMs, log, callerSignal: signal }) };
    } catch (error) {
      const cancelled = error?.name === "AbortError" || signal?.aborted;
      postFinish({ runId, status: cancelled ? "cancelled" : "failed", errorMessage: String(error?.message || error).slice(0, 5000), headers, proxyOptions, timeoutMs, log });
      throw error;
    } finally {
      delete credentials.__freebuffRunId;
      delete credentials.__freebuffInstanceId;
    }
  }
}

export default FreebuffExecutor;
