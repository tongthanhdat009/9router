/** Muse usage: stored snapshot maps with zero network; force mints exactly once. */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { getMuseUsage } from "../../open-sse/services/usage/muse.js";

const originalFetch = global.fetch;
const SECONDS = 1700000000;
const ISO = new Date(SECONDS * 1000).toISOString();

function stored(providerSpecificData, accessToken = "at-1") {
  return getMuseUsage(accessToken, null, { providerSpecificData });
}

function mintResponse(payload) {
  return { ok: true, status: 200, json: () => Promise.resolve(payload), text: () => Promise.resolve("") };
}

describe("muse usage", () => {
  beforeEach(() => { vi.clearAllMocks(); global.fetch = originalFetch; });
  afterEach(() => { global.fetch = originalFetch; });

  it("maps stored snapshot with zero network", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock;
    const usage = await stored({
      museUsage: {
        window: { used_percent: 25, window_duration_mins: 300, resets_at: SECONDS },
        weekly: { used_percent: 80, window_duration_mins: 10080, resets_at: SECONDS * 1000 },
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(usage.quotas["5h"]).toMatchObject({ used: 25, total: 100, remaining: 75, resetAt: ISO, unlimited: false });
    expect(usage.quotas.Weekly).toMatchObject({ used: 80, total: 100, remaining: 20, resetAt: ISO });
  });

  it("keeps one Current bar when weekly is absent", async () => {
    global.fetch = vi.fn();
    const usage = await stored({ museUsage: { window: { used_percent: 0, window_duration_mins: 30, resets_at: SECONDS } } });
    expect(Object.keys(usage.quotas)).toEqual(["30m"]);
    expect(usage.quotas["30m"]).toMatchObject({ used: 0, remaining: 100 });
  });

  it("parses seconds, milliseconds, and ISO resets", async () => {
    global.fetch = vi.fn();
    const iso = "2026-01-02T03:04:05.000Z";
    const base = { used_percent: 10, window_duration_mins: 60 };
    const a = await stored({ museUsage: { window: { ...base, resets_at: SECONDS } } });
    const b = await stored({ museUsage: { window: { ...base, resets_at: SECONDS * 1000 } } });
    const c = await stored({ museUsage: { window: { ...base, resets_at: iso } } });
    expect(a.quotas["1h"].resetAt).toBe(ISO);
    expect(b.quotas["1h"].resetAt).toBe(ISO);
    expect(c.quotas["1h"].resetAt).toBe(iso);
  });

  it("returns empty quotas when snapshot is null", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock;
    // No accessToken: cannot seed, plain empty, zero network.
    expect(await getMuseUsage(null, null, {})).toEqual({ quotas: {} });
    expect(await getMuseUsage(null, null, { providerSpecificData: { museUsage: null } })).toEqual({ quotas: {} });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("force mints exactly once and maps the fresh snapshot", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mintResponse({
      api_key: "mk-fresh",
      subs_usage: { window: { used_percent: 50, window_duration_mins: 300, resets_at: SECONDS } },
    }));
    global.fetch = fetchMock;
    const usage = await getMuseUsage("at-1", null, {
      force: true,
      providerSpecificData: { museUsage: { window: { used_percent: 1, window_duration_mins: 300, resets_at: SECONDS } } },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("/muse-code/key");
    expect(usage.quotas["5h"]).toMatchObject({ used: 50, remaining: 50 });
  });

  it("seeds once on first load, then serves stored with zero network", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mintResponse({
      api_key: "mk-seed",
      subs_usage: { window: { used_percent: 12, window_duration_mins: 300, resets_at: SECONDS } },
    }));
    global.fetch = fetchMock;
    const seeded = await getMuseUsage("at-1", null, { providerSpecificData: {} });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(seeded.quotas["5h"]).toMatchObject({ used: 12 });
    expect(seeded.museSnapshot.window.used_percent).toBe(12);
    // Stored snapshot served without network; failure still returns stale.
    global.fetch = vi.fn();
    const again = await getMuseUsage("at-1", null, { providerSpecificData: { museUsage: seeded.museSnapshot } });
    expect(again.quotas["5h"]).toMatchObject({ used: 12 });
  });

  it("backs off reseeding for a day after an empty mint", async () => {
    const empty = mintResponse({ api_key: "mk-empty" });
    const fetchMock = vi.fn().mockResolvedValue(empty);
    global.fetch = fetchMock;
    const first = await getMuseUsage("at-1", null, { providerSpecificData: {} });
    expect(first).toEqual({ quotas: {}, museSeedAttempted: true });
    // Stamped connection stops minting until the tombstone expires.
    global.fetch = vi.fn();
    const second = await getMuseUsage("at-1", null, { providerSpecificData: { museUsageSeededAt: Date.now() } });
    expect(second).toEqual({ quotas: {} });
  });

  it("falls back to stored snapshot when force mint rejects", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("mint failed"));
    const usage = await getMuseUsage("at-1", null, {
      force: true,
      providerSpecificData: { museUsage: { window: { used_percent: 25, window_duration_mins: 300, resets_at: SECONDS } } },
    });
    expect(usage.quotas["5h"]).toMatchObject({ used: 25, remaining: 75 });
  });
});
