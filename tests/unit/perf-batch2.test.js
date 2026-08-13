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

function streamFromChunks(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

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

  it("finds transient Codex errors in an 8KB sliding peek window", async () => {
    const executor = new CodexExecutor();
    const response = new Response(streamFromChunks([
      `data: ${"x".repeat(4096)}\n`,
      'event: error\ndata: {"error":{"message":"server_is_overloaded"}}\n\n',
    ]), { status: 200 });
    const peek = await executor._peekSseTransientError(response);
    expect(peek.matched).toBe("server_is_overloaded");
  });
});
