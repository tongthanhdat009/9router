/** Muse quota is returned only by the key-mint response and persisted on the connection. */

import { mintMuseKey } from "../../../src/lib/oauth/services/muse.js";
import { parseResetTime } from "./shared.js";

function finitePercent(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : null;
}

function labelFor(window, fallback) {
  const minutes = Number(window?.window_duration_mins);
  if (!Number.isFinite(minutes) || minutes <= 0) return fallback;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function quotaFor(window, fallback) {
  if (!window || typeof window !== "object") return null;
  const used = finitePercent(window.used_percent ?? window.percent_used);
  if (used === null) return null;
  return {
    label: labelFor(window, fallback),
    quota: {
      used,
      total: 100,
      remaining: 100 - used,
      resetAt: parseResetTime(window.resets_at ?? window.reset_at),
      unlimited: false,
    },
  };
}

function mapSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const quotas = {};
  const current = quotaFor(snapshot.window ?? snapshot.current ?? snapshot, "Current");
  if (current) quotas[current.label] = current.quota;
  const weekly = quotaFor(snapshot.weekly ?? snapshot.week, "Weekly");
  if (weekly) quotas.Weekly = weekly.quota;
  return Object.keys(quotas).length ? quotas : null;
}

export async function getMuseUsage(accessToken, proxyOptions = null, options = {}) {
  void proxyOptions;
  if (options?.force === true && accessToken) {
    const minted = await mintMuseKey(accessToken, {});
    const fresh = mapSnapshot(minted?.museUsage);
    if (fresh) return { quotas: fresh };
  }
  return { quotas: mapSnapshot(options?.providerSpecificData?.museUsage) || {} };
}
