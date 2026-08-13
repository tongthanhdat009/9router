import { describe, it, expect, vi, beforeEach } from "vitest";

describe("refreshWithRetry permanent short-circuit", () => {
  beforeEach(() => vi.resetModules());
  it("returns permanent error immediately, does not retry", async () => {
    const { refreshWithRetry } = await import("../../open-sse/services/tokenRefresh.js");
    let calls = 0;
    const fn = async () => { calls++; return { error: "unrecoverable_refresh_error", code: "refresh_token_invalidated" }; };
    const res = await refreshWithRetry(fn, 3, null);
    expect(res.error).toBe("unrecoverable_refresh_error");
    expect(calls).toBe(1);
  });
  it("retries on null until maxRetries", async () => {
    const { refreshWithRetry } = await import("../../open-sse/services/tokenRefresh.js");
    let calls = 0;
    const fn = async () => { calls++; return null; };
    const res = await refreshWithRetry(fn, 3, null);
    expect(res).toBeNull();
    expect(calls).toBe(3);
  });
});
