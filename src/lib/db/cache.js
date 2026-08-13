// ponytail: single-process in-memory TTL; upgrade to shared cache when scaling instances.
export function makeTtlCache({ ttlMs, loader, getKey = (key) => key }) {
  const store = new Map();
  return {
    async get(key) {
      const cacheKey = getKey(key);
      const entry = store.get(cacheKey);
      const now = Date.now();
      if (entry && now - entry.ts < ttlMs) return entry.value;
      const value = await loader(key);
      store.set(cacheKey, { value, ts: now });
      return value;
    },
    invalidate(key) { store.delete(getKey(key)); },
    invalidateAll() { store.clear(); },
  };
}
