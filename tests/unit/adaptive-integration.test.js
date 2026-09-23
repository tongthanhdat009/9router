import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSSEStream } from "../../open-sse/utils/stream.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { normalizeUsage, extractUsage } from "../../open-sse/utils/usageTracking.js";
import { adaptiveRouter } from "../../open-sse/services/adaptiveRouter.js";
import { handleComboChat, resetComboRotation } from "../../open-sse/services/combo.js";

const mocks = vi.hoisted(() => ({
  connections: vi.fn(), settings: vi.fn(), update: vi.fn(), pools: vi.fn(), proxy: vi.fn(),
}));
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.connections,
  getSettings: mocks.settings,
  updateProviderConnection: mocks.update,
  getProxyPools: mocks.pools,
  validateApiKey: vi.fn(),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.proxy,
  pickProxyPoolId: vi.fn(() => null),
}));
vi.mock("@/sse/services/antigravityQuota.js", () => ({
  getAntigravityQuotaCache: () => new Map(Object.entries(mocks.quota)),
}));

const { getProviderCredentials } = await import("@/sse/services/auth.js");

const log = { info() {}, warn() {}, error() {} };
const accounts = [
  { id: "slow", providerSpecificData: { connectionProxyUrl: "http://slow-proxy" } },
  { id: "fast", providerSpecificData: { connectionProxyUrl: "http://fast-proxy" } },
];
// Speed-learning sample (1600 tokens over 4s = 400 TPS) for the "fast" account.
function sample(connectionId, modelId = "model") {
  return adaptiveRouter.recordObservation({
    layer: "account", providerId: "openai", modelId, connectionId,
    outcome: "success", completionTokens: 1600, semanticTtftMs: 400, streamSpanMs: 4000,
  });
}
const encoder = new TextEncoder();
function frames(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}
const chat = (data) => "data: " + JSON.stringify(data) + "\n\n";
async function stream(chunks, targetFormat = FORMATS.OPENAI, sourceFormat = targetFormat, mode = "passthrough") {
  const observations = [];
  const transformed = frames(chunks).pipeThrough(createSSEStream({
    mode, provider: "openai", model: "model",
    body: { messages: [{ role: "user", content: "hi" }] },
    targetFormat, sourceFormat,
    onStreamComplete: (_content, usage, _ttft, semantic) => observations.push({ usage, semantic }),
  }));
  const output = await new Response(transformed).text();
  return { output, observations };
}

beforeEach(() => {
  adaptiveRouter.reset();
  resetComboRotation();
  vi.clearAllMocks();
  mocks.quota = {};
  mocks.connections.mockResolvedValue(accounts);
  mocks.settings.mockResolvedValue({ providerStrategies: { openai: { fallbackStrategy: "adaptive-round-robin" } } });
  mocks.proxy.mockImplementation(async (data) => ({
    connectionProxyEnabled: Boolean(data.connectionProxyUrl),
    connectionProxyUrl: data.connectionProxyUrl || "",
  }));
});

describe("adaptive handler lifecycle integration", () => {
  it.each([
    ["fallback", "fill-first"],
    ["fallback", "adaptive-round-robin"],
    ["adaptive-round-robin", "fill-first"],
    ["adaptive-round-robin", "adaptive-round-robin"],
  ])("route=%s account=%s: real combo attempt, proxy fields, no post-commit second upstream", async (route, account) => {
    mocks.settings.mockResolvedValue({ providerStrategies: { openai: { fallbackStrategy: account } } });
    sample("fast");
    const attempts = [];
    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["openai/model", "openai/backup"],
      comboName: "outer",
      comboStrategy: route,
      log,
      handleSingleModel: async (_body, model) => {
        const credential = await getProviderCredentials("openai", null, "model", { adaptiveAccount: true });
        attempts.push({ model, credential });
        if (credential.adaptiveAccountLease) adaptiveRouter.release(credential.adaptiveAccountLease);
        return new Response("committed", { status: 200 });
      },
    });
    expect(response.status).toBe(200);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].model).toBe("openai/model");
    if (account === "adaptive-round-robin") {
      expect(attempts[0].credential.connectionId).toBe("fast");
      expect(attempts[0].credential.adaptiveStrategy).toBe("adaptive-round-robin");
    } else {
      expect(attempts[0].credential.connectionId).toBe("slow");
    }
    expect(attempts[0].credential.providerSpecificData.connectionProxyUrl).toContain(attempts[0].credential.connectionId);
    const busy = adaptiveRouter.snapshot().entries.filter((entry) => entry.key[0] === "account").every((entry) => entry.inFlight === 0);
    expect(busy).toBe(true);
  });

  it("direct-model sessionless adaptive: opportunistic affinity overridden, explicit pin never", async () => {
    sample("fast");
    const selected = await getProviderCredentials("openai", null, "model", { adaptiveAccount: true, preferredConnectionId: "slow" });
    expect(selected.connectionId).toBe("fast");
    adaptiveRouter.release(selected.adaptiveAccountLease);
    const pinned = await getProviderCredentials("openai", null, "model", { adaptiveAccount: true, explicitConnectionId: "slow" });
    expect(pinned.connectionId).toBe("slow");
    expect(pinned.adaptiveAccountLease).toBeNull();
  });

  it("eligibility: model lock, refresh failure, antigravity quota excluded before adaptive pick", async () => {
    sample("fast");
    const future = new Date(Date.now() + 60000).toISOString();
    mocks.connections.mockResolvedValueOnce([{ ...accounts[0], ["modelLock_model"]: future }, accounts[1]]);
    const locked = await getProviderCredentials("openai", null, "model", { adaptiveAccount: true });
    expect(locked.connectionId).toBe("fast");
    adaptiveRouter.release(locked.adaptiveAccountLease);
    mocks.connections.mockResolvedValueOnce([{ ...accounts[0], lastErrorType: "token_refresh_failed" }, accounts[1]]);
    const refreshDead = await getProviderCredentials("openai", null, "model", { adaptiveAccount: true });
    expect(refreshDead.connectionId).toBe("fast");
    adaptiveRouter.release(refreshDead.adaptiveAccountLease);
    mocks.quota = { slow: { model: { remainingPercentage: 0, resetAt: future } } };
    mocks.connections.mockResolvedValueOnce(accounts);
    mocks.settings.mockResolvedValueOnce({ providerStrategies: { antigravity: { fallbackStrategy: "adaptive-round-robin" } } });
    const quotaBlocked = await getProviderCredentials("antigravity", null, "model", { adaptiveAccount: true });
    expect(quotaBlocked.connectionId).toBe("fast");
    if (quotaBlocked.adaptiveAccountLease) adaptiveRouter.release(quotaBlocked.adaptiveAccountLease);
  });

  it("no lifecycle flag or layer disabled: legacy pick without reservation", async () => {
    sample("fast");
    const nonChat = await getProviderCredentials("openai", null, "model");
    expect(nonChat.adaptiveAccountLease).toBeNull();
    expect(nonChat.connectionId).toBe("slow");
    mocks.settings.mockResolvedValue({ providerStrategies: { openai: { fallbackStrategy: "fill-first" } } });
    const disabled = await getProviderCredentials("openai", null, "model", { adaptiveAccount: true });
    expect(disabled.connectionId).toBe("slow");
    expect(disabled.adaptiveAccountLease).toBeNull();
  });

  it("adaptive combo attempts every route once, outer and inner invocation", async () => {
    const attempted = [];
    const run = (comboName) => {
      adaptiveRouter.reset();
      resetComboRotation();
      return handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["openai/model", "openai/backup"],
      comboName,
      comboStrategy: "adaptive-round-robin",
      log,
      handleSingleModel: async (_body, model) => {
        attempted.push(model);
        return new Response(model === "openai/model" ? "err" : "ok", { status: model === "openai/model" ? 503 : 200 });
      },
      });
    };
    expect((await run("outer")).status).toBe(200);
    expect(attempted).toEqual(["openai/model", "openai/backup"]);
    attempted.length = 0;
    expect((await run("inner")).status).toBe(200);
    expect(attempted).toEqual(["openai/model", "openai/backup"]);
  });

  it("final-only/dup/malformed/truncated Chat passthrough: usage + semantic counted once", async () => {
    const full = await stream([
      chat({ choices: [{ delta: { role: "assistant" } }] }),
      chat({ choices: [{ delta: { reasoning_content: "think" } }] }),
      "data: {malformed\n\n",
      chat({ choices: [{ delta: { tool_calls: [{ id: "call_1", function: { name: "search", arguments: "{}" } }] } }] }),
      chat({ choices: [], usage: { prompt_tokens: 24, completion_tokens: 80, completion_tokens_details: { reasoning_tokens: 10 } } }),
      "data: [DONE]\n\n",
      "data: [DONE]\n\n",
    ]);
    expect(full.observations).toHaveLength(1);
    expect(full.observations[0].usage.completion_tokens).toBe(80);
    expect(full.observations[0].semantic).toBeTypeOf("number");
    const truncated = await stream([
      chat({ choices: [{ delta: { role: "assistant" } }] }),
    ]);
    expect(truncated.observations).toHaveLength(1);
    expect(truncated.observations[0].usage).toBeNull();
  });

  it("error stream: no successful observation recorded", async () => {
    adaptiveRouter.recordObservation({
      layer: "account", providerId: "openai", modelId: "model", connectionId: "fast",
      outcome: "failure",
    });
    expect(adaptiveRouter.snapshot().entries.filter((entry) => entry.key[3] === "fast")).toHaveLength(0);
    const lease = adaptiveRouter.reserve({ layer: "account", providerId: "openai", modelId: "model", connectionId: "fast" });
    adaptiveRouter.recordObservation({
      layer: "account", providerId: "openai", modelId: "model", connectionId: "fast",
      outcome: "failure", generation: lease.generation,
    });
    expect(adaptiveRouter.release(lease)).toBe(true);
  });

  it("non-stream latency-only path: lease releases without a TPS sample", () => {
    sample("fast");
    const before = adaptiveRouter.snapshot().entries.find((entry) => entry.key[3] === "fast").samples;
    const lease = adaptiveRouter.reserve({ layer: "account", providerId: "openai", modelId: "model", connectionId: "fast" });
    expect(lease).not.toBeNull();
    expect(adaptiveRouter.recordObservation({
      layer: "account", providerId: "openai", modelId: "model", connectionId: "fast",
      outcome: "success", completionTokens: 200, semanticTtftMs: null, streamSpanMs: null, generation: lease.generation,
    })).toMatchObject({ accepted: false, reason: "invalid_timing" });
    expect(adaptiveRouter.release(lease)).toBe(true);
    expect(adaptiveRouter.snapshot().entries.find((entry) => entry.key[3] === "fast").samples).toBe(before);
  });

  it("Responses passthrough: output_tokens maps once to completion_tokens", async () => {
    const response = { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 96, output_tokens_details: { reasoning_tokens: 24 } } } };
    expect(extractUsage(response)).toMatchObject({ completion_tokens: 96, reasoning_tokens: 24 });
    const result = await stream([
      "event: response.output_text.delta\ndata: " + JSON.stringify({ type: "response.output_text.delta", delta: "hello" }) + "\n\n",
      "event: response.completed\ndata: " + JSON.stringify(response) + "\n\n",
    ], FORMATS.OPENAI_RESPONSES);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].usage.completion_tokens).toBe(96);
    expect(result.observations[0].semantic).toBeTypeOf("number");
  });

  it("estimated usage: normalize path disposition blocks TPS sampling", () => {
    const usage = normalizeUsage({ prompt_tokens: 12, completion_tokens: 80, estimated: true });
    expect(usage.estimated).toBe(true);
    expect(adaptiveRouter.recordObservation({
      layer: "account", providerId: "openai", modelId: "model", connectionId: "slow",
      outcome: "success", completionTokens: usage.completion_tokens, semanticTtftMs: 5, streamSpanMs: 1000, estimated: usage.estimated,
    })).toMatchObject({ accepted: false, reason: "estimated_usage" });
  });
});
