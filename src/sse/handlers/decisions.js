// Handle decisions requests (OpenRouter SystemOne: noul/choice/score answers).
// Shape: { model: "openrouter/typesafe/jev-1.13", state, questions, provider?, ... } —
// forwarded byte-preserving to POST {decisionsConfig.baseUrl}, same as video proxy.
// Docs: https://openrouter.ai/docs/guides/community/typesafe-sdk
import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { getSettings, getComboByName } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "../services/model.js";
import { isDecisionsModel } from "open-sse/config/providerModels.js";
import { handleComboChat } from "open-sse/services/combo.js";
import { handleDecisionsProxyCore, getDecisionsConfig } from "open-sse/handlers/decisionsCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { persistRefreshedCredentials, checkAndRefreshToken, recordUnrecoverableRefreshFailure } from "../services/tokenRefresh.js";
import { saveRequestUsage } from "@/lib/usageDb.js";
import * as log from "../utils/logger.js";

const DEFAULT_DECISIONS_PROVIDER = "openrouter";

function exactDecisionsUsage(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const promptTokens = raw.prompt_tokens ?? raw.input_tokens;
  const completionTokens = raw.completion_tokens ?? raw.output_tokens ?? 0;
  const totalTokens = raw.total_tokens ?? (Number.isSafeInteger(promptTokens) ? promptTokens + completionTokens : undefined);
  if (!Number.isSafeInteger(promptTokens) || promptTokens < 0) return null;
  if (!Number.isSafeInteger(completionTokens) || completionTokens < 0) return null;
  return { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens };
}

/**
 * Handle decisions request: POST /v1/decisions.
 * @param {Request} request
 */
export async function handleDecisions(request) {
  let raw;
  let parsed;
  try {
    raw = await request.text();
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    log.warn("DECISIONS", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const url = new URL(request.url);
  const modelStr = parsed?.model;
  log.request("POST", `${url.pathname} | ${modelStr || "(no model)"}`);

  const apiKey = extractApiKey(request);
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    const valid = await isValidApiKey(apiKey);
    if (!valid) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
  }

  if (!modelStr) {
    log.warn("DECISIONS", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }
  if (parsed?.state === undefined || parsed?.questions === undefined) {
    log.warn("DECISIONS", "Missing state/questions");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: state, questions");
  }

  // Combo expansion: model may be a combo name → run fallback/round-robin across
  // DECISIONS members only. Members are "prefix/id" strings; a bare provider name
  // (media combo placeholder) or an unknown passthrough id is NOT attempted —
  // forwarding it would hit upstream as a bogus model and burn a real request.
  const comboModels = (await getComboModels(String(modelStr)))?.filter((m) => {
    if (typeof m !== "string" || !m.includes("/")) return false;
    const slash = m.indexOf("/");
    return isDecisionsModel(m.slice(0, slash), m.slice(slash + 1));
  });
  // Named combo with zero decisions members (e.g. chat-only combo called here):
  // fail fast without touching upstream or credentials.
  if (!comboModels?.length && !String(modelStr).includes("/") && await getComboByName(String(modelStr))) {
    log.warn("DECISIONS", `Combo has no decisions members: ${modelStr}`);
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `Combo '${modelStr}' has no decisions-capable members`);
  }
  if (comboModels?.length) {
    const comboStrategies = settings.comboStrategies || {};
    const comboStrategy = comboStrategies[modelStr]?.fallbackStrategy || settings.comboStrategy || "fallback";
    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("DECISIONS", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body: parsed,
      models: comboModels,
      handleSingleModel: (b, m) => handleSingleModelDecisions({ ...b, model: m }, request, { raw, apiKey, url }),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
    });
  }

  return handleSingleModelDecisions(parsed, request, { raw, apiKey, url });
}

async function handleSingleModelDecisions(body, request, { raw, apiKey, url }) {
  const modelStr = body?.model;
  const parsed = body;

  const modelInfo = await getModelInfo(String(modelStr));
  let provider = modelInfo?.provider || null;
  let model = modelInfo?.model || null;
  if (!provider) {
    // Bare model ids (no "provider/" prefix) default to openrouter — the only decisions provider today.
    if (!String(modelStr).includes("/")) {
      provider = DEFAULT_DECISIONS_PROVIDER;
      model = String(modelStr);
    } else {
      log.warn("DECISIONS", "Invalid model format", { model: modelStr });
      return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
    }
  }
  if (!getDecisionsConfig(provider)) {
    if (!String(modelStr).includes("/")) {
      provider = DEFAULT_DECISIONS_PROVIDER;
      model = String(modelStr);
    } else {
      return errorResponse(HTTP_STATUS.BAD_REQUEST, `Provider '${provider}' does not support decisions`);
    }
  }

  // noAuth providers (e.g. opencode free tier) use a virtual "Public" credential —
  // never store refresh/error state for it, and skip account-lock bookkeeping.
  const isNoAuthProvider = provider === "opencode";

  // Rebuild the forward body from the per-member model id + shared state/questions
  // (combo path swaps model per member, so raw bytes no longer apply). Non-combo
  // path keeps stripping only the provider prefix, nothing else reshaped.
  let forwardBody = raw;
  if (parsed.model !== model || !raw) {
    forwardBody = JSON.stringify({ ...parsed, model });
  }

  const preferredConnectionId = request.headers.get("x-connection-id") || null;
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, { preferredConnectionId });

    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("DECISIONS", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        log.error("AUTH", `No credentials for provider: ${provider}`);
        return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
      }
      log.warn("DECISIONS", "No more accounts available", { provider });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    log.info("AUTH", `Using ${provider} account: ${credentials.connectionName}`);
    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    if (refreshedCredentials._needsReauth) {
      const reauthError = "Token refresh failed, re-authentication required";
      await markAccountUnavailable(credentials.connectionId, HTTP_STATUS.UNAUTHORIZED, reauthError, provider, model);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = reauthError;
      lastStatus = HTTP_STATUS.UNAUTHORIZED;
      continue;
    }

    const proxyOptions = {
      connectionProxyEnabled: refreshedCredentials?.providerSpecificData?.connectionProxyEnabled === true,
      connectionProxyUrl: refreshedCredentials?.providerSpecificData?.connectionProxyUrl || "",
      connectionNoProxy: refreshedCredentials?.providerSpecificData?.connectionNoProxy || "",
      vercelRelayUrl: refreshedCredentials?.providerSpecificData?.vercelRelayUrl || "",
    };

    const result = await handleDecisionsProxyCore({
      provider,
      rawBody: forwardBody,
      credentials: refreshedCredentials,
      signal: request.signal,
      proxyOptions,
      log,
      onCredentialsRefreshed: async (newCreds) => {
        if (newCreds.__terminalRefreshFailure) { await recordUnrecoverableRefreshFailure(credentials.connectionId, newCreds.__terminalRefreshFailure); return; }
        await persistRefreshedCredentials(credentials.connectionId, { ...newCreds, testStatus: "active" }, credentials.providerSpecificData);
      },
    });

    if (result.success) {
      if (!isNoAuthProvider) await clearAccountError(credentials.connectionId, credentials, model);
      const usage = exactDecisionsUsage(result.usage);
      if (usage) {
        saveRequestUsage({
          provider,
          model,
          connectionId: credentials.connectionId,
          apiKey,
          endpoint: url.pathname,
          tokens: usage,
          status: "success",
        }).catch(() => {});
      }
      log.info("DECISIONS", `${provider.toUpperCase()} | ${model} ok (connection ${credentials.connectionId})`);
      const headers = new Headers(result.response.headers);
      headers.set("x-9router-connection-id", String(credentials.connectionId));
      return new Response(result.response.body, { status: result.response.status, headers });
    }

    const { shouldFallback } = isNoAuthProvider
      ? { shouldFallback: false }
      : await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model);
    if (shouldFallback) {
      log.warn("AUTH", `Account ${credentials.connectionName} unavailable (${result.status}), trying fallback`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }
    return result.response;
  }
}
