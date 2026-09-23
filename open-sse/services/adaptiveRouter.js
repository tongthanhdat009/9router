import * as defaults from "../config/adaptive.js";

/** Process-local adaptive scheduler. Callers canonicalize provider/model aliases before entry. */
export function createAdaptiveRouter({ now = Date.now, config = {} } = {}) {
  const c = { ...defaults, ...config };
  const entries = new Map();
  const leases = new Map();
  let generation = 0;
  let nextLease = 0;
  const key = (layer, providerId, modelId, connectionId = null) => JSON.stringify([layer, providerId, modelId, layer === "route" ? null : connectionId]);
  const valid = (value) => typeof value === "string" && value.length > 0;
  const isCooled = (entry) => Boolean(entry?.cooledUntil) && entry.cooledUntil > now();
  const weight = (entry) => score(entry) / (1 + (entry?.inFlight || 0) * c.inflightPenalty);
  const probeReady = (entry) => entry.probeCount < c.maxConcurrentProbesPerKey && (entry.probedAt == null || now() - entry.probedAt >= c.cooldownMs);
  const touch = (id, entry) => { entries.delete(id); entries.set(id, entry); };
  function lookup(id, create = false) {
    let entry = entries.get(id);
    if (entry && now() - entry.lastAt >= c.staleTtlMs) {
      entries.delete(id);
      entry = null;
    }
    if (!entry && create) {
      entry = { lastAt: now(), samples: 0, inFlight: 0, probeCount: 0, slowStreak: 0, cooledUntil: 0, probedAt: null, current: 0 };
      entries.set(id, entry);
      while (entries.size > c.maxKeys) entries.delete(entries.keys().next().value);
    } else if (entry) touch(id, entry);
    return entry;
  }
  function score(entry) {
    if (!entry?.samples) return c.neutralColdPrior;
    const measured = entry.tps / (1 + entry.ttft / c.latencyScaleMs);
    return (measured * entry.samples + c.neutralColdPrior * c.priorSamples) / (entry.samples + c.priorSamples) * (entry.ramp ?? 1);
  }
  function idsFor(layer, providerId, modelId, candidates) {
    if (!valid(providerId) || !valid(modelId) || !Array.isArray(candidates)) return [];
    return [...new Map(candidates.map((item) => {
      const connectionId = layer === "account" ? (typeof item === "string" ? item : item?.connectionId) : null;
      const routeProvider = layer === "route" ? item?.providerId ?? providerId : providerId;
      const routeModel = layer === "route" ? item?.modelId ?? (typeof item === "string" ? item : modelId) : modelId;
      if (!valid(routeProvider) || !valid(routeModel) || (layer === "account" && !valid(connectionId))) return [null, null];
      return [key(layer, routeProvider, routeModel, connectionId), item];
    }).filter(([id]) => id)).entries()];
  }
  function select(layer, { providerId, modelId, candidates, allowProbe = true } = {}) {
    const pairs = idsFor(layer, providerId, modelId, candidates);
    const healthy = [], cooled = [], reasons = {};
    for (const [id, item] of pairs) {
      const entry = lookup(id);
      if (isCooled(entry)) { cooled.push([id, item, entry]); reasons[layer === "account" ? (typeof item === "string" ? item : item.connectionId) : id] = "cooldown"; }
      else healthy.push([id, item, entry]);
    }
    // A probe requires an explicit reservation by the caller; selection never consumes the budget.
    const probe = allowProbe ? cooled.find(([, , entry]) => probeReady(entry)) : null;
    const baseWeights = healthy.map(([, , e]) => weight(e));
    const min = Math.min(...baseWeights);
    const weights = baseWeights.map((w) => Math.min(w, min * c.weightRatioCap));
    // One SWRR advance per selection; remaining fallback candidates retain their input order.
    let winner = -1, best = -Infinity;
    healthy.forEach(([id], index) => {
      const e = lookup(id, true);
      e.current += weights[index];
      if (e.current > best) { best = e.current; winner = index; }
    });
    if (winner >= 0) lookup(healthy[winner][0]).current -= weights.reduce((a, b) => a + b, 0);
    const ordered = winner < 0 ? [] : [healthy[winner][1], ...healthy.filter((_, i) => i !== winner).map(([, item]) => item)];
    if (probe) ordered.push(probe[1]);
    return { ordered, probe: probe?.[1] ?? null, reasons };
  }
  function reserve({ layer, providerId, modelId, connectionId = null, probe = false } = {}) {
    if (!["route", "account"].includes(layer) || !valid(providerId) || !valid(modelId) || (layer === "account" && !valid(connectionId))) return null;
    const id = key(layer, providerId, modelId, connectionId);
    const entry = lookup(id, true);
    if (probe ? (!isCooled(entry) || !probeReady(entry)) : isCooled(entry)) return null;
    if (probe) entry.probeCount++;
    entry.inFlight++;
    const lease = { id: ++nextLease, generation, layer, key: id, probe };
    leases.set(lease.id, lease);
    return lease;
  }
  function release(lease) {
    if (!lease || leases.get(lease.id) !== lease || lease.generation !== generation) return false;
    leases.delete(lease.id);
    const entry = entries.get(lease.key);
    if (entry) {
      entry.inFlight = Math.max(0, entry.inFlight - 1);
      if (lease.probe) entry.probeCount = Math.max(0, entry.probeCount - 1);
    }
    return true;
  }
  function recordObservation(obs = {}, leaseProbe = null) {
    const { layer = "account", providerId, modelId, connectionId, outcome, completionTokens, semanticTtftMs, streamSpanMs, estimated, generation: observedGeneration } = obs;
    if (observedGeneration !== undefined && observedGeneration !== generation) return { accepted: false, reason: "stale_generation" };
    if (outcome === "cancelled") return { accepted: false, reason: "cancelled" };
    if (outcome !== "success") return { accepted: false, reason: "not_success" };
    if (estimated) return { accepted: false, reason: "estimated_usage" };
    if (!valid(providerId) || !valid(modelId) || (layer === "account" && !valid(connectionId))) return { accepted: false, reason: "invalid_key" };
    if (!Number.isFinite(completionTokens) || completionTokens < c.minSampleTokens) return { accepted: false, reason: "insufficient_tokens" };
    if (!Number.isFinite(streamSpanMs) || streamSpanMs <= 0 || !Number.isFinite(semanticTtftMs) || semanticTtftMs < 0) return { accepted: false, reason: "invalid_timing" };
    const tps = completionTokens * 1000 / Math.max(streamSpanMs, c.minSpanMs);
    if (!Number.isFinite(tps) || tps <= 0) return { accepted: false, reason: "invalid_tps" };
    const probeSuccess = leaseProbe?.probe === true && tps >= c.recoveryTpsMargin;
    const update = (id) => {
      const e = lookup(id, true);
      e.tps = e.samples ? c.ewmaAlpha * tps + (1 - c.ewmaAlpha) * e.tps : tps;
      e.ttft = e.samples ? c.ewmaAlpha * semanticTtftMs + (1 - c.ewmaAlpha) * e.ttft : semanticTtftMs;
      e.samples++;
      e.lastAt = now();
      if (tps < c.slowTps) {
        e.slowStreak++;
        if (e.slowStreak >= c.slowStreakThreshold) e.cooledUntil = now() + c.cooldownMs;
      } else if (probeSuccess || !isCooled(e)) {
        e.slowStreak = 0;
        if (probeSuccess && isCooled(e)) { e.cooledUntil = 0; e.ramp = c.recoveryRamp; }
        else if (e.ramp) e.ramp = Math.min(1, e.ramp + c.ewmaAlpha);
      }
    };
    update(key(layer, providerId, modelId, connectionId));
    if (layer === "account") update(key("route", providerId, modelId));
    return { accepted: true, reason: "sampled", tps };
  }
  function markProbeResult(lease, observation) {
    if (!lease?.probe || leases.get(lease.id) !== lease || lease.generation !== generation) return { accepted: false, reason: "stale_probe" };
    const entry = entries.get(lease.key);
    const result = observation?.outcome === "success" ? recordObservation({ ...observation, layer: lease.layer, generation }, lease) : { accepted: false, reason: observation?.outcome === "cancelled" ? "cancelled" : "probe_failed" };
    if (entry) entry.probedAt = now();
    if (entry && result.accepted && result.tps >= c.recoveryTpsMargin) {
      entry.cooledUntil = 0;
      entry.slowStreak = 0;
      entry.ramp = c.recoveryRamp;
    } else if (entry) entry.cooledUntil = now() + c.cooldownMs;
    release(lease);
    return result;
  }
  function invalidate({ layer, providerId, modelId, connectionId } = {}) {
    generation++;
    for (const id of entries.keys()) {
      const [l, p, m, a] = JSON.parse(id);
      if ((layer === undefined || layer === l) && (providerId === undefined || providerId === p) && (modelId === undefined || modelId === m) && (connectionId === undefined || connectionId === a)) entries.delete(id);
    }
    leases.clear();
  }
  function reset() { generation++; entries.clear(); leases.clear(); }
  function snapshot() {
    const result = [];
    for (const [id, e] of entries) {
      if (now() - e.lastAt >= c.staleTtlMs) { entries.delete(id); continue; }
      result.push({ key: JSON.parse(id), samples: e.samples, tps: e.tps ?? null, ttftMs: e.ttft ?? null, score: score(e), inFlight: e.inFlight, probeCount: e.probeCount, cooledUntil: e.cooledUntil });
    }
    return { generation, entries: result.slice(-c.maxKeys) };
  }
  return { recordObservation, selectAccount: (args) => select("account", args), selectRoute: (args) => select("route", args), reserve, release, markProbeResult, invalidate, reset, snapshot, getGeneration: () => generation };
}

export const adaptiveRouter = createAdaptiveRouter();
