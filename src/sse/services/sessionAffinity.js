const TTL_MS = 30 * 60 * 1000;
const ROUTE_LIMIT = 4096;
const ACCOUNT_LIMIT = 8192;

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
  if (sessionId && route) routes.bind(key(sessionId, routeScope), { route });
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
