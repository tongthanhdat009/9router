import { describe, expect, it, vi } from "vitest";
import { makeTtlCache } from "@/lib/db/cache.js";
import { CodexExecutor } from "../../open-sse/executors/codex.js";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("@/lib/localDb", () => mocks);
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
  pickProxyPoolId: vi.fn(),
}));
vi.mock("open-sse/services/accountFallback.js", () => ({
  formatRetryAfter: vi.fn(), checkFallbackError: vi.fn(), isModelLockActive: vi.fn(() => false),
  buildModelLockUpdate: vi.fn(), getEarliestModelLockUntil: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  resolveProviderId: (provider) => provider,
  FREE_PROVIDERS: {},
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), warn: vi.fn(), info: vi.fn() }));

describe("Batch 2 performance guards", () => {
  it("TTL cache reuses entries then invalidates", async () => {
    const loader = vi.fn(async (key) => `${key}-${loader.mock.calls.length}`);
    const cache = makeTtlCache({ ttlMs: 10000, loader });
    expect(await cache.get("x")).toBe("x-1");
    expect(await cache.get("x")).toBe("x-1");
    expect(loader).toHaveBeenCalledTimes(1);
    cache.invalidate("x");
    expect(await cache.get("x")).toBe("x-2");
    cache.invalidateAll();
    expect(await cache.get("x")).toBe("x-3");
  });

  it("serializes selections only within one provider", async () => {
    const { getProviderCredentials } = await import("@/sse/services/auth.js");
    mocks.getSettings.mockResolvedValue({ providerStrategies: {} });
    mocks.resolveConnectionProxyConfig.mockResolvedValue({});
    mocks.getProviderConnections.mockImplementation(async ({ provider }) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return [{ id: provider, providerSpecificData: {} }];
    });
    const started = Date.now();
    await Promise.all([getProviderCredentials("alpha"), getProviderCredentials("beta")]);
    expect(Date.now() - started).toBeLessThan(70);
    expect(mocks.getProviderConnections).toHaveBeenCalledTimes(2);
  });

  it("shares concurrent usage-stat recomputation and invalidates on writes", async () => {
    const db = await import("@/lib/db/index.js");
    const [first, second] = await Promise.all([db.getCachedUsageStats(), db.getCachedUsageStats()]);
    expect(first).toBe(second);
    await db.saveRequestUsage({ provider: "cache-test", model: "m", tokens: { prompt_tokens: 1 } });
    const refreshed = await db.getCachedUsageStats();
    expect(refreshed).not.toBe(first);
  });

  it("closes an evicted proxy dispatcher when the cache exceeds its cap", async () => {
    const originalFetch = globalThis.fetch;
    const close = vi.fn(async () => {});
    close.mockRejectedValueOnce(new Error("close failed"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ProxyAgent = vi.fn(function ProxyAgent(options) {
      this.options = options;
      this.close = close;
    });
    vi.doMock("undici", () => ({ ProxyAgent }));
    globalThis.fetch = vi.fn(async () => new Response("ok"));
    vi.resetModules();
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

    try {
      for (let i = 0; i <= 20; i++) {
        await proxyAwareFetch("https://opencode.ai/zen/v1/chat/completions", {}, {
          enabled: true,
          url: `http://proxy-${i}.example:8080`,
          strictProxy: true,
        });
      }
      expect(ProxyAgent).toHaveBeenCalledTimes(21);
      expect(close).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
        "[ProxyFetch] Failed to close evicted proxy dispatcher: close failed"
      ));
    } finally {
      globalThis.fetch = originalFetch;
      vi.doUnmock("undici");
      vi.resetModules();
    }
  });

  it("cancels upstream once a pre-output transient marker completes across chunks", async () => {
    const executor = new CodexExecutor();
    const encoder = new TextEncoder();
    const marker = "event: error\ndata: {\"error\":{\"message\":\"server_is_overloaded\"}}\n\n";
    const split = marker.length >> 1;
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(marker.slice(0, split)));
        controller.enqueue(encoder.encode(marker.slice(split)));
        controller.close();
      },
    }), { status: 200 });

    const peek = executor._peekSseTransientError(response);
    // Pass-through forwards the first partial chunk immediately, then stops
    // when the marker completes — so the full error never reaches downstream.
    const received = await new Response(peek.replacementBody).text();
    expect(received).not.toContain("server_is_overloaded");
  });
});
