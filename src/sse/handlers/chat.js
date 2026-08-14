import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { handleComboChat, handleFusionChat, detectRequiredCapabilities } from "open-sse/services/combo.js";
import { augmentModelsWithCapacityAdapter, withCapacityAdapterStripping, getActiveAdapterStrategy, modelSatisfiesHardCapabilities } from "open-sse/services/capacityAdapter.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, persistRefreshedCredentials, checkAndRefreshToken, recordUnrecoverableRefreshFailure } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { resolveClientAffinitySessionId, sha16 } from "open-sse/utils/sessionManager.js";
import { getAccountAffinity, bindAccountAffinity, invalidateAccountAffinity, getRouteAffinity, bindRouteAffinity, invalidateRouteAffinity } from "../services/sessionAffinity.js";
import { logAffinity } from "@/lib/affinityLogger.js";

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null) {
  let affinityCtx = null;
  try {
    return await handleChatInner(request, clientRawRequest, (ctx) => { affinityCtx = ctx; });
  } catch (err) {
    // Outer exception safety: finalize only when no streaming Response was handed
    // to the client (stream terminal hooks own that case).
    if (affinityCtx && !affinityCtx.diagnostics.finalized && !affinityCtx.diagnostics.streamPending) {
      affinityCtx.finalizeAffinityRequest({ status: err?.status ?? 500 });
    }
    throw err;
  }
}

async function handleChatInner(request, clientRawRequest = null, registerAffinityCtx = null) {
  // Affinity identity exists at handleChat entry (plan: exactly one affinity.request
  // per outer client request) — malformed JSON must still be finalized.
  const diagnostics = {
    requestId: `req-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    startedAt: Date.now(), sessionHash: null, routeScope: null, attemptCount: 0,
    finalized: false, streamPending: false, usage: null,
    affinity: { route: { eligible: false, hit: false, missReason: null, boundProvider: null, boundModel: null, switched: false }, account: { eligible: false, hit: false, missReason: null, preferredConnectionId: null, switched: false } },
    selection: { provider: null, model: null, connectionId: null, routeSource: "single_model", accountSource: null, comboStrategy: null, comboRotationUsed: false },
    fallback: { accountFallbackCount: 0, routeFallbackCount: 0, lastReason: null },
    cacheIdentity: { promptCacheKeyPresent: false, promptCacheKeyHash: null, previousResponseIdPresent: false, cacheControlPresent: false, cacheBreakpointCount: 0 },
  };
  const finalizeAffinityRequest = ({ status = null, usage = null } = {}) => {
    if (diagnostics.finalized) return;
    diagnostics.finalized = true;
    if (usage) diagnostics.usage = usage;
    logAffinity("affinity.request", { ...diagnostics, usage: diagnostics.usage, status, latencyMs: Date.now() - diagnostics.startedAt });
  };
  if (registerAffinityCtx) registerAffinityCtx({ diagnostics, finalizeAffinityRequest });
  const finish = (response) => { finalizeAffinityRequest({ status: response?.status ?? null }); return response; };
  // Outer-response boundary: mark handed-out SSE Responses as stream-pending (stream
  // terminal hooks finalize later, after usage exists); finalize everything else now.
  const finishOuter = async (promise) => {
    const response = await promise;
    if (!diagnostics.finalized) {
      if (/text\/event-stream/i.test(response?.headers?.get?.("content-type") || "")) diagnostics.streamPending = true;
      else finalizeAffinityRequest({ status: response?.status ?? null });
    }
    return response;
  };

  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("CHAT", "Invalid JSON body");
    return finish(errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body"));
  }

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }
  const modelStr = body.model;
  const cacheKey = body.prompt_cache_key ?? body.promptCacheKey;
  diagnostics.routeScope = modelStr || null;
  diagnostics.cacheIdentity = { promptCacheKeyPresent: cacheKey != null, promptCacheKeyHash: cacheKey == null ? null : sha16(String(cacheKey)), previousResponseIdPresent: (body.previous_response_id ?? body.previousResponseId) != null, cacheControlPresent: body.cache_control != null || body.cacheControl != null, cacheBreakpointCount: Array.isArray(body.cache_control?.breakpoints) ? body.cache_control.breakpoints.length : 0 };

  // Request summary is emitted as the unified "▶" line in chatCore (has fmt/thinking/account)

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  const apiKey = extractApiKey(request);
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return finish(errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key"));
    }
    const valid = await isValidApiKey(apiKey);
    if (!valid) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return finish(errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key"));
    }
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return finish(errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model"));
  }

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return finish(bypassResponse.response || bypassResponse);

  const requiredCapabilities = detectRequiredCapabilities(body);

  // Check if model is a combo (has multiple models with fallback)
  const comboModels = await getComboModels(modelStr);
  const affinityScope = modelStr.startsWith("kiro/") || comboModels?.every((m) => m.startsWith("kiro/")) ? "kiro" : "";
  const affinitySessionId = resolveClientAffinitySessionId({
    headers: Object.fromEntries(request.headers.entries()),
    body,
    scope: affinityScope,
  });
  diagnostics.sessionHash = affinitySessionId ? sha16(affinitySessionId) : null;
  if (comboModels) {
    // Check for combo-specific strategy first, fallback to global
    const comboStrategies = settings.comboStrategies || {};
    const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
    const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";
    const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, settings);
    const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

    if (comboStrategy === "fusion") {
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
      diagnostics.finalized = true; // Fusion stays outside affinity diagnostics scope.
      return handleFusionChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m, isPanel) => {
          let cleanRawReq = clientRawRequest;
          if (isPanel && clientRawRequest) {
            const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
            cleanRawReq = { ...clientRawRequest, body: cleanBody };
          }
          return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, affinitySessionId);
        },
        log,
        comboName: modelStr,
        judgeModel: comboStrategies[modelStr]?.judgeModel,
        tuning: comboStrategies[modelStr]?.fusionTuning,
      });
    }

    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    const routeAffinity = getRouteAffinity(affinitySessionId, modelStr);
    // A stored route is only honored if it still satisfies the current request's
    // hard capabilities. Otherwise it falls through to normal combo rotation.
    const preferredRoute = routeAffinity?.route &&
      augmentedModels.includes(routeAffinity.route) &&
      modelSatisfiesHardCapabilities(routeAffinity.route, requiredCapabilities)
      ? routeAffinity.route
      : null;
    if (routeAffinity && !preferredRoute) invalidateRouteAffinity(affinitySessionId, modelStr);
    log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    diagnostics.affinity.route = { eligible: Boolean(affinitySessionId), hit: Boolean(preferredRoute), missReason: affinitySessionId ? (preferredRoute ? null : (routeAffinity ? "hard_capability_mismatch" : "no_binding")) : "no_session", boundProvider: routeAffinity?.route?.split("/")[0] || null, boundModel: routeAffinity?.route || null, switched: false };
    diagnostics.selection.routeSource = preferredRoute ? "route_affinity" : "combo_initial";
    diagnostics.selection.comboStrategy = comboStrategy === "round-robin" ? "round-robin" : "fallback";
    return finishOuter(handleComboChat({
      body,
      models: augmentedModels,
      onSelection: ({ rotationUsed }) => { diagnostics.selection.comboRotationUsed = rotationUsed; },
      handleSingleModel: withCapacityAdapterStripping(
        async (b, m) => {
          // Route-affinity diagnostics for this combo attempt; account fields are
          // owned by the account loop inside handleSingleModelChat.
          const routePrior = routeAffinity?.route || null;
          if (diagnostics.selection.provider && `${diagnostics.selection.provider}/${diagnostics.selection.model}` !== m) { diagnostics.fallback.routeFallbackCount++; diagnostics.fallback.lastReason = "route_fallback"; diagnostics.selection.routeSource = "combo_fallback"; }
          if (preferredRoute && m !== preferredRoute) {
            const r = getRouteAffinity(affinitySessionId, modelStr);
            if (r?.route === preferredRoute) logAffinity("affinity.invariant_violation", { code: "AFFINITY_ROUTE_HIT_ROTATED_COMBO", requestId: diagnostics.requestId, preferredRoute, selected: m });
          }
          const response = await handleSingleModelChat(b, m, clientRawRequest, request, apiKey, affinitySessionId, {
            routeAffinityHit: Boolean(preferredRoute) && m === preferredRoute,
            routeSwitch: Boolean(routePrior && routePrior !== m),
            rebindReason: routePrior && routePrior !== m ? "route-fallback" : null,
          }, diagnostics, finalizeAffinityRequest);
          if (response.ok) {
            if (routePrior && routePrior !== m) logAffinity("affinity.rebind", { requestId: diagnostics.requestId, sessionHash: diagnostics.sessionHash, layer: "route", fromProvider: routePrior.split("/")[0] || null, fromModel: routePrior, toProvider: m.split("/")[0] || null, toModel: m, reason: "route_fallback" });
            bindRouteAffinity(affinitySessionId, modelStr, m);
          }
          else if (m === preferredRoute) invalidateRouteAffinity(affinitySessionId, modelStr);
          return response;
        },
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
      preferredRoute,
    }));
  }

  // Single model request — may still switch to a capacity-adapter model if the
  // target lacks a capability the request needs (e.g. no vision, request has an image).
  const soloAugmented = augmentModelsWithCapacityAdapter([modelStr], requiredCapabilities, settings);
  if (soloAugmented.length > 1) {
    const adapterAdded = soloAugmented.filter((m) => m !== modelStr);
    log.info("CHAT", `Capacity adapter for [${[...requiredCapabilities].join(",")}] on "${modelStr}" → trying ${soloAugmented.join(", ")}`);
    return finishOuter(handleComboChat({
      body,
      models: soloAugmented,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, affinitySessionId, null, diagnostics, finalizeAffinityRequest),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy: getActiveAdapterStrategy(requiredCapabilities, settings)
    }));
  }

  return finishOuter(handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, affinitySessionId, null, diagnostics, finalizeAffinityRequest));
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, affinitySessionId = null, affinityMeta = null, diagnostics = null, finalizeAffinityRequest = null) {
  const modelInfo = await getModelInfo(modelStr);

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      const chatSettings = await getSettings();
      // Check for combo-specific strategy first, fallback to global
      const comboStrategies = chatSettings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || chatSettings.comboStrategy || "fallback";
      const requiredCapabilities = detectRequiredCapabilities(body);
      const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, chatSettings);
      const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

      if (comboStrategy === "fusion") {
        log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
        return handleFusionChat({
          body,
          models: comboModels,
          handleSingleModel: (b, m, isPanel) => {
            let cleanRawReq = clientRawRequest;
            if (isPanel && clientRawRequest) {
              const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
              cleanRawReq = { ...clientRawRequest, body: cleanBody };
            }
            return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, affinitySessionId, null, diagnostics, finalizeAffinityRequest);
          },
          log,
          comboName: modelStr,
          judgeModel: comboStrategies[modelStr]?.judgeModel,
          tuning: comboStrategies[modelStr]?.fusionTuning,
        });
      }

      const comboStickyLimit = chatSettings.comboStickyRoundRobinLimit;
      const routeAffinity = getRouteAffinity(affinitySessionId, modelStr);
      const preferredRoute = routeAffinity?.route &&
        augmentedModels.includes(routeAffinity.route) &&
        modelSatisfiesHardCapabilities(routeAffinity.route, requiredCapabilities)
        ? routeAffinity.route
        : null;
      if (routeAffinity && !preferredRoute) invalidateRouteAffinity(affinitySessionId, modelStr);
      log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      diagnostics.affinity.route = { eligible: Boolean(affinitySessionId), hit: Boolean(preferredRoute), missReason: affinitySessionId ? (preferredRoute ? null : (routeAffinity ? "hard_capability_mismatch" : "no_binding")) : "no_session", boundProvider: routeAffinity?.route?.split("/")[0] || null, boundModel: routeAffinity?.route || null, switched: false };
      diagnostics.selection.routeSource = preferredRoute ? "route_affinity" : "combo_initial";
      diagnostics.selection.comboStrategy = comboStrategy === "round-robin" ? "round-robin" : "fallback";
      // handleSingleModelChat has no finishOuter of its own — outer handleChat
      // lifecycle (finishOuter/stream hooks) owns finalization for this promise.
      return handleComboChat({
        body,
        models: augmentedModels,
        onSelection: ({ rotationUsed }) => { diagnostics.selection.comboRotationUsed = rotationUsed; },
        handleSingleModel: withCapacityAdapterStripping(
          async (b, m) => {
            const routePrior = routeAffinity?.route || null;
            if (diagnostics.selection.provider && `${diagnostics.selection.provider}/${diagnostics.selection.model}` !== m) { diagnostics.fallback.routeFallbackCount++; diagnostics.fallback.lastReason = "route_fallback"; diagnostics.selection.routeSource = "combo_fallback"; }
            if (preferredRoute && m !== preferredRoute && getRouteAffinity(affinitySessionId, modelStr)?.route === preferredRoute) logAffinity("affinity.invariant_violation", { code: "AFFINITY_ROUTE_HIT_ROTATED_COMBO", requestId: diagnostics.requestId, preferredRoute, selected: m });
            const response = await handleSingleModelChat(b, m, clientRawRequest, request, apiKey, affinitySessionId, {
              routeAffinityHit: Boolean(preferredRoute) && m === preferredRoute,
              routeSwitch: Boolean(routePrior && routePrior !== m),
              rebindReason: routePrior && routePrior !== m ? "route-fallback" : null,
            }, diagnostics, finalizeAffinityRequest);
            if (response.ok) {
              if (routePrior && routePrior !== m) logAffinity("affinity.rebind", { requestId: diagnostics.requestId, sessionHash: diagnostics.sessionHash, layer: "route", fromProvider: routePrior.split("/")[0] || null, fromModel: routePrior, toProvider: m.split("/")[0] || null, toModel: m, reason: "route_fallback" });
              bindRouteAffinity(affinitySessionId, modelStr, m);
            }
            else if (m === preferredRoute) invalidateRouteAffinity(affinitySessionId, modelStr);
            return response;
          },
          adapterAdded
        ),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit,
        preferredRoute,
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    // Combo-context failures (affinityMeta set) leave finalization to the outer combo lifecycle.
    return finalizeAffinityRequest && !affinityMeta ? (finalizeAffinityRequest({ status: HTTP_STATUS.BAD_REQUEST }), errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format")) : errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;

  // Routing shown in the unified "▶" line (client model → provider/model)

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  const accountPrior = getAccountAffinity(affinitySessionId, provider, model);
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const affinity = getAccountAffinity(affinitySessionId, provider, model);
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, {
      preferredConnectionId: affinity?.connectionId || null,
    });
    if (affinity && credentials?.connectionId !== affinity.connectionId) {
      logAffinity("affinity.invariant_violation", { code: "AFFINITY_ACCOUNT_HIT_SELECTED_OTHER", requestId: diagnostics.requestId, provider, model, preferredConnectionId: affinity.connectionId, selected: credentials?.connectionId ?? null });
      invalidateAccountAffinity(affinitySessionId, provider, model);
    }

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return finalizeAffinityRequest && !affinityMeta ? (finalizeAffinityRequest({ status }), unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman)) : unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        // Single-model requests finalize here; combo attempts defer to the outer combo lifecycle.
        return finalizeAffinityRequest && !affinityMeta ? (finalizeAffinityRequest({ status: HTTP_STATUS.NOT_FOUND }), errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`)) : errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
      }
      log.warn("CHAT", "No more accounts available", { provider });
      return finalizeAffinityRequest && !affinityMeta ? (finalizeAffinityRequest({ status: lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE }), errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable")) : errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    // Account selection shown in the unified "▶" line (acc:...)
    if (diagnostics) {
      diagnostics.attemptCount++;
      diagnostics.selection = { ...diagnostics.selection, provider, model, connectionId: credentials.connectionId, accountSource: affinity?.connectionId === credentials.connectionId ? "account_affinity" : (excludeConnectionIds.size ? "account_fallback" : "fill_first") };
      diagnostics.affinity.account = { eligible: Boolean(affinitySessionId), hit: Boolean(affinity?.connectionId === credentials.connectionId), missReason: affinitySessionId ? (affinity ? (affinity.connectionId === credentials.connectionId ? null : "preferred_ineligible") : "no_binding") : "no_session", preferredConnectionId: affinity?.connectionId || null, switched: Boolean(accountPrior?.connectionId && credentials.connectionId !== accountPrior.connectionId) };
    }
    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    if (refreshedCredentials._needsReauth) {
      const reauthError = "Token refresh failed, re-authentication required";
      invalidateAccountAffinity(affinitySessionId, provider, model);
      await markAccountUnavailable(credentials.connectionId, HTTP_STATUS.UNAUTHORIZED, reauthError, provider, model);
      log.warn("AUTH", `Account ${credentials.connectionName} token refresh failed, needs re-auth (401)`);
      if (diagnostics) { diagnostics.fallback.accountFallbackCount++; diagnostics.fallback.lastReason = "account_fallback"; }
      excludeConnectionIds.add(credentials.connectionId);
      lastError = "Token refresh failed, re-authentication required";
      lastStatus = HTTP_STATUS.UNAUTHORIZED;
      continue;
    }

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken, provider);
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
      }
    }

    // Use shared chatCore
    const chatSettings = await getSettings();
    const providerThinking = (chatSettings.providerThinking || {})[provider] || null;
    const result = await handleChatCore({
      body: { ...body, model: `${provider}/${model}` },
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      clientRawRequest,
      connectionId: credentials.connectionId,
      userAgent,
      apiKey,
      ccFilterNaming: !!chatSettings.ccFilterNaming,
      rtkEnabled: !!chatSettings.rtkEnabled,
      headroomEnabled: !!chatSettings.headroomEnabled,
      headroomUrl: chatSettings.headroomUrl || DEFAULT_HEADROOM_URL,
      headroomCompressUserMessages: !!chatSettings.headroomCompressUserMessages,
      cavemanEnabled: !!chatSettings.cavemanEnabled,
      cavemanLevel: chatSettings.cavemanLevel || "full",
      ponytailEnabled: !!chatSettings.ponytailEnabled,
      ponytailLevel: chatSettings.ponytailLevel || "full",
      pxpipeEnabled: !!chatSettings.pxpipeEnabled,
      pxpipeMinChars: chatSettings.pxpipeMinChars,
      pxpipeTimeoutMs: chatSettings.pxpipeTimeoutMs,
      // Lazily warms the in-process module on first use; null when not installed (fail-open)
      pxpipeTransform: chatSettings.pxpipeEnabled ? await getPxpipeTransform() : null,
      onPxpipeEvent: appendPxpipeEvent,
      providerThinking,
      affinityDiagnostics: diagnostics,
      finalizeAffinityRequest,
      affinity: {
        sessionHash: affinitySessionId ? sha16(affinitySessionId) : null,
        routeAffinityHit: false,
        accountAffinityHit: Boolean(affinity && credentials.connectionId === affinity.connectionId),
        routeSwitch: false,
        accountSwitch: Boolean(accountPrior?.connectionId && credentials.connectionId !== accountPrior.connectionId),
        rebindReason: accountPrior?.connectionId && credentials.connectionId !== accountPrior.connectionId ? "account-fallback" : null,
        // Combo route-affinity diagnostics (when invoked from the combo loop)
        // refine the route fields above; account fields stay owned here.
        ...(affinityMeta || {}),
      },
      // Detect source format by endpoint + body
      sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
      onCredentialsRefreshed: async (newCreds) => {
        if (newCreds.__terminalRefreshFailure) {
          await recordUnrecoverableRefreshFailure(credentials.connectionId, newCreds.__terminalRefreshFailure);
          return;
        }
        await persistRefreshedCredentials(credentials.connectionId, { ...newCreds, testStatus: "active" }, credentials.providerSpecificData);
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
        if (diagnostics && accountPrior?.connectionId && accountPrior.connectionId !== credentials.connectionId) logAffinity("affinity.rebind", { requestId: diagnostics.requestId, sessionHash: diagnostics.sessionHash, layer: "account", provider, model, fromConnectionId: accountPrior.connectionId, toConnectionId: credentials.connectionId, reason: "account_fallback" });
        bindAccountAffinity(affinitySessionId, provider, model, credentials.connectionId);
      }
    });

    if (result.success) {
      if (diagnostics && result.response?.body && /text\/event-stream/i.test(result.response.headers?.get?.("content-type") || "")) diagnostics.streamPending = true;
      return result.response;
    }

    // Mark account unavailable (auto-calculates cooldown with exponential backoff, or precise resetsAtMs)
    invalidateAccountAffinity(affinitySessionId, provider, model);
    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, result.resetsAtMs);

    if (shouldFallback) {
      log.warn("FALLBACK", `⇄ ACC:${credentials.connectionName} UNAVAILABLE (${result.status}) → NEXT ACCOUNT`);
      if (diagnostics) { diagnostics.fallback.accountFallbackCount++; diagnostics.fallback.lastReason = "account_fallback"; }
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    if (finalizeAffinityRequest) finalizeAffinityRequest({ status: result.response?.status ?? result.status ?? null });
    return result.response;
  }
}
