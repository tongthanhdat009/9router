import crypto from "node:crypto";
import { DefaultExecutor } from "./default.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";

const AUTH_BASE = "https://www.codebuff.com";
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
    delete transformed.runId;
    delete transformed.clientId;
    delete transformed.extraCodebuffMetadata;
    transformed.codebuff_metadata = {
      ...supplied,
      run_id: credentials.__freebuffRunId,
      client_id: stableClientId(credentials),
      trace_session_id: supplied.trace_session_id || body?.trace_session_id || body?.session_id || body?.conversation_id || credentials?._clientSessionId || credentials?.providerSpecificData?.traceSessionId || crypto.randomUUID(),
      cost_mode: (credentials?.providerSpecificData?.costMode || credentials?.connectionMetadata?.costMode || credentials?.costMode) === "free" ? "free" : "normal",
    };
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
    const startBody = { action: "START", agentId: "9router", ...(userId ? { userId } : {}) };
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
    try {
      // START mints the reserved run id, so an earlier generic preparation cannot be reused.
      const result = await super.execute({ model, body, stream, credentials, signal, log, proxyOptions, requestId, preparedRequest: null });
      if (!result.response.ok) {
        postFinish({ runId, status: "failed", errorMessage: "Chat request failed with HTTP " + result.response.status, headers, proxyOptions, timeoutMs, log });
        return result;
      }
      return { ...result, response: wrapWithTerminalFinish(result.response, { runId, headers, proxyOptions, timeoutMs, log, callerSignal: signal }) };
    } catch (error) {
      const cancelled = error?.name === "AbortError" || signal?.aborted;
      postFinish({ runId, status: cancelled ? "cancelled" : "failed", errorMessage: String(error?.message || error).slice(0, 5000), headers, proxyOptions, timeoutMs, log });
      throw error;
    } finally {
      delete credentials.__freebuffRunId;
    }
  }
}

export default FreebuffExecutor;
