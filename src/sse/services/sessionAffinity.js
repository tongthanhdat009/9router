const TTL_MS = 30 * 60 * 1000;
const ROUTE_LIMIT = 4096;
const ACCOUNT_LIMIT = 8192;

function positiveEnv(name, fallback, integer = false) {
  const value = integer ? Number.parseInt(process.env[name] || String(fallback), 10) : Number(process.env[name] || fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const AFFINITY_MIN_TPS = positiveEnv("AFFINITY_MIN_TPS", 12);
const AFFINITY_RECOVERY_TPS = Math.max(AFFINITY_MIN_TPS, positiveEnv("AFFINITY_RECOVERY_TPS", 18));
const AFFINITY_SLOW_STREAK = positiveEnv("AFFINITY_SLOW_STREAK", 2, true);
export const AFFINITY_MIN_SAMPLE_TOKENS = positiveEnv("AFFINITY_MIN_SAMPLE_TOKENS", 64, true);

function key(...parts) {
  return parts.join("\0");
}

function createStore(limit) {
  const store = new Map();
  function sweep(now = Date.now()) {
    for (const [entryKey, entry] of store) if (entry.expiresAt <= now) store.delete(entryKey);
  }
  function get(entryKey) {
    const entry = store.get(entryKey);
    if (!entry || entry.expiresAt <= Date.now()) {
      store.delete(entryKey);
      return null;
    }
    entry.lastUsedAt = Date.now();
    store.delete(entryKey);
    store.set(entryKey, entry);
    return entry;
  }
  function bind(entryKey, value) {
    const now = Date.now();
    sweep(now);
    store.delete(entryKey);
    while (store.size >= limit) store.delete(store.keys().next().value);
    store.set(entryKey, { ...value, expiresAt: now + TTL_MS, lastUsedAt: now });
  }
  return { get, bind, invalidate: (entryKey) => store.delete(entryKey), sweep, clear: () => store.clear() };
}

const routes = createStore(ROUTE_LIMIT);
const accounts = createStore(ACCOUNT_LIMIT);

export function getRouteAffinity(sessionId, routeScope) {
  return sessionId ? routes.get(key(sessionId, routeScope)) : null;
}

export function bindRouteAffinity(sessionId, routeScope, route) {
  if (!sessionId || !route) return;
  const entryKey = key(sessionId, routeScope);
  const existing = routes.get(entryKey);
  routes.bind(entryKey, existing?.route === route
    ? { route, slowStreak: existing.slowStreak || 0, escapeNext: Boolean(existing.escapeNext) }
    : { route, slowStreak: 0, escapeNext: false });
}

export function consumeRouteAffinityEscape(sessionId, routeScope) {
  const entry = getRouteAffinity(sessionId, routeScope);
  if (!entry?.escapeNext) return null;
  entry.escapeNext = false;
  return { route: entry.route };
}

export function recordRouteAffinityThroughput({ sessionId, routeScope, route, completionTokens, firstSemanticGenerationAt, streamEndAt, estimated }) {
  if (!sessionId) return { ignored: "no_session" };
  if (!route) return { ignored: "no_route" };
  if (estimated) return { ignored: "estimated_usage" };
  if (!Number.isFinite(completionTokens) || completionTokens < AFFINITY_MIN_SAMPLE_TOKENS) return { ignored: "insufficient_tokens" };
  if (!firstSemanticGenerationAt || streamEndAt <= firstSemanticGenerationAt) return { ignored: "no_semantic_timing" };
  const entry = getRouteAffinity(sessionId, routeScope);
  if (!entry || entry.route !== route) return { ignored: "stale_route" };
  const tps = completionTokens / ((streamEndAt - firstSemanticGenerationAt) / 1000);
  if (!Number.isFinite(tps) || tps <= 0) return { ignored: "invalid_tps" };
  const priorSlowStreak = entry.slowStreak || 0;
  const priorEscapeNext = Boolean(entry.escapeNext);
  if (tps < AFFINITY_MIN_TPS) {
    entry.slowStreak = priorSlowStreak + 1;
    if (entry.slowStreak >= AFFINITY_SLOW_STREAK) entry.escapeNext = true;
  } else if (tps >= AFFINITY_RECOVERY_TPS) {
    entry.slowStreak = 0;
    entry.escapeNext = false;
  }
  return { tps, completionTokens, slowStreak: entry.slowStreak || 0, recovered: priorSlowStreak > 0 && entry.slowStreak === 0, escapeArmed: !priorEscapeNext && Boolean(entry.escapeNext) };
}

export function invalidateRouteAffinity(sessionId, routeScope) {
  if (sessionId) routes.invalidate(key(sessionId, routeScope));
}

export function getAccountAffinity(sessionId, provider, model) {
  return sessionId ? accounts.get(key(sessionId, provider, model)) : null;
}

export function bindAccountAffinity(sessionId, provider, model, connectionId) {
  if (sessionId && connectionId) accounts.bind(key(sessionId, provider, model), { connectionId });
}

export function invalidateAccountAffinity(sessionId, provider, model) {
  if (sessionId) accounts.invalidate(key(sessionId, provider, model));
}

export function clearSessionAffinity() {
  routes.clear();
  accounts.clear();
}
