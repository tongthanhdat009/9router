// Decisions proxy core (OpenRouter SystemOne / alpha-decisions shape).
// Transparent JSON pass-through: POST {config.baseUrl} with { model, state, questions, ... },
// upstream JSON (id/model/answers/usage) returned verbatim. No translation — answers carry
// noul/choice/score types that must not round-trip through the chat pipeline.
// Docs: https://openrouter.ai/docs/guides/community/typesafe-sdk
import { createErrorResult, parseUpstreamError, formatProviderError } from "../utils/error.js";
import { HTTP_STATUS, FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { refreshTokenByProvider } from "../services/tokenRefresh.js";
import { PROVIDER_MEDIA } from "../providers/index.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

export function getDecisionsConfig(provider) {
  return PROVIDER_MEDIA[provider]?.decisionsConfig || null;
}

function buildHeaders({ token, extra, bearer }) {
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  // noAuth providers (opencode free) ignore caller tokens — upstream only accepts "public".
  headers.Authorization = `Bearer ${bearer || token}`;
  if (extra && typeof extra === "object") Object.assign(headers, extra);
  return headers;
}

/**
 * @param {object} options
 * @param {string} options.provider - Provider id (must have registry decisionsConfig)
 * @param {string|Buffer|null} [options.rawBody] - Exact body to forward
 * @param {object} options.credentials - { accessToken?, apiKey?, refreshToken? }
 * @param {AbortSignal} [options.signal]
 * @param {object|null} [options.proxyOptions]
 * @param {number} [options.timeoutMs]
 * @param {object} [options.log]
 * @param {function} [options.onCredentialsRefreshed]
 * @returns {Promise<{ success: boolean, response: Response, status?: number, error?: string, usage?: object }>}
 */
export async function handleDecisionsProxyCore({
  provider,
  rawBody = null,
  credentials,
  signal,
  proxyOptions = null,
  timeoutMs = FETCH_CONNECT_TIMEOUT_MS,
  log,
  onCredentialsRefreshed,
}) {
  const config = getDecisionsConfig(provider);
  if (!config?.baseUrl) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, `Provider '${provider}' does not support decisions`);
  }
  const url = String(config.baseUrl).replace(/\/$/, "");
  const timeoutSignal = typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(timeoutMs) : null;
  const fetchSignal = signal && timeoutSignal && typeof AbortSignal.any === "function"
    ? AbortSignal.any([signal, timeoutSignal])
    : signal || timeoutSignal || undefined;

  const doFetch = async () => proxyAwareFetch(url, {
    method: "POST",
    headers: buildHeaders({
      token: credentials?.accessToken || credentials?.apiKey,
      // noAuth providers (e.g. opencode free) send "public"; caller tokens are ignored.
      bearer: credentials?.connectionId === "noauth" || credentials?.id === "noauth"
        ? credentials?.accessToken
        : undefined,
      extra: config.headers || {},
    }),
    body: typeof rawBody === "string" || rawBody instanceof Uint8Array || (typeof Buffer !== "undefined" && Buffer.isBuffer(rawBody))
      ? rawBody
      : JSON.stringify(rawBody ?? {}),
    signal: fetchSignal,
  }, proxyOptions);

  let upstream;
  try {
    upstream = await doFetch();
  } catch (error) {
    const errMsg = formatProviderError(error, provider, "decisions", HTTP_STATUS.BAD_GATEWAY);
    log?.debug?.("DECISIONS", `Fetch error: ${errMsg}`);
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, errMsg);
  }

  // 401/403 → refresh once → retry once (API keys can't refresh, only OAuth).
  if (
    (upstream.status === HTTP_STATUS.UNAUTHORIZED || upstream.status === HTTP_STATUS.FORBIDDEN) &&
    credentials?.refreshToken
  ) {
    let refreshed = null;
    try {
      refreshed = await refreshTokenByProvider(provider, credentials, log);
    } catch (error) {
      log?.warn?.("TOKEN", `${provider} | decisions refresh error: ${error?.message || error}`);
    }
    if (refreshed?.accessToken || refreshed?.apiKey) {
      Object.assign(credentials, refreshed);
      if (onCredentialsRefreshed) await onCredentialsRefreshed(refreshed);
      try { await upstream.body?.cancel?.(); } catch { /* noop */ }
      try {
        upstream = await doFetch();
      } catch (error) {
        const errMsg = formatProviderError(error, provider, "decisions", HTTP_STATUS.BAD_GATEWAY);
        return createErrorResult(HTTP_STATUS.BAD_GATEWAY, errMsg);
      }
    } else {
      log?.warn?.("TOKEN", `${provider.toUpperCase()} | decisions refresh failed — account needs re-auth`);
    }
  }

  const bodyText = await upstream.text().catch(() => "");
  if (!upstream.ok) {
    const { statusCode, message } = await parseUpstreamError(
      new Response(bodyText, { status: upstream.status, headers: { "Content-Type": "application/json" } }),
    );
    const errMsg = formatProviderError(new Error(message), provider, "decisions", statusCode);
    log?.debug?.("DECISIONS", `Provider error: ${errMsg}`);
    return createErrorResult(statusCode, `[${provider}] ${String(message).slice(0, 2000)}`);
  }

  let parsed = null;
  try {
    parsed = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, `Invalid JSON response from ${provider}`);
  }

  return {
    success: true,
    usage: parsed?.usage || null,
    response: new Response(JSON.stringify(parsed), {
      status: upstream.status,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    }),
  };
}
