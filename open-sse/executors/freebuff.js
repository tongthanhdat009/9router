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
    const startBody = { status: "START", agentId: "9router", ...(userId ? { userId } : {}) };
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
    let failure = null;
    try {
      // START mints the reserved run id, so an earlier generic preparation cannot be reused.
      return await super.execute({ model, body, stream, credentials, signal, log, proxyOptions, requestId, preparedRequest: null });
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      const finishBody = {
        status: "FINISH",
        runId,
        totalSteps: 1,
        directCredits: 0,
        totalCredits: 0,
        errorMessage: failure ? String(failure.message || failure) : null,
        steps: [],
      };
      lifecycleFetch(AUTH_BASE + "/api/v1/agent-runs", {
        method: "POST",
        headers,
        body: JSON.stringify(finishBody),
        signal,
      }, proxyOptions, timeoutMs).catch(() => {});
      delete credentials.__freebuffRunId;
    }
  }
}

export default FreebuffExecutor;
