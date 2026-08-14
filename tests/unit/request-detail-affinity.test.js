import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../../src/lib/usageDb.js", () => ({ saveRequestUsage: vi.fn(() => Promise.resolve()), appendRequestLog: vi.fn(() => Promise.resolve()), saveRequestDetail: vi.fn(() => Promise.resolve()), trackPendingRequest: vi.fn() }));
vi.mock("../../open-sse/utils/stream.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, COLORS: { green: "", reset: "" } };
});
const lifecycleMocks = vi.hoisted(() => ({
  getSettings: vi.fn(), extractApiKey: vi.fn(() => null), isValidApiKey: vi.fn(),
  getProviderCredentials: vi.fn(), markAccountUnavailable: vi.fn(), clearAccountError: vi.fn(),
  getModelInfo: vi.fn(), getComboModels: vi.fn(), checkAndRefreshToken: vi.fn(),
  updateProviderCredentials: vi.fn(), persistRefreshedCredentials: vi.fn(), recordUnrecoverableRefreshFailure: vi.fn(),
}));
vi.mock("@/sse/services/auth.js", () => ({ getProviderCredentials: lifecycleMocks.getProviderCredentials, markAccountUnavailable: lifecycleMocks.markAccountUnavailable, clearAccountError: lifecycleMocks.clearAccountError, extractApiKey: lifecycleMocks.extractApiKey, isValidApiKey: lifecycleMocks.isValidApiKey }));
vi.mock("@/lib/localDb", () => ({ getSettings: lifecycleMocks.getSettings }));
vi.mock("@/sse/services/model.js", () => ({ getModelInfo: lifecycleMocks.getModelInfo, getComboModels: lifecycleMocks.getComboModels, parseModel: () => ({ provider: "openai", model: "gpt-4o" }) }));
vi.mock("@/sse/services/tokenRefresh.js", () => ({ updateProviderCredentials: lifecycleMocks.updateProviderCredentials, persistRefreshedCredentials: lifecycleMocks.persistRefreshedCredentials, checkAndRefreshToken: lifecycleMocks.checkAndRefreshToken, recordUnrecoverableRefreshFailure: lifecycleMocks.recordUnrecoverableRefreshFailure }));
vi.mock("open-sse/services/projectId.js", () => ({ getProjectIdForConnection: vi.fn() }));
vi.mock("@/sse/utils/logger.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn(), errorLine: vi.fn(), line: vi.fn(), maskKey: vi.fn(() => "masked"), request: vi.fn(), _id: vi.fn() };
});
vi.mock("open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: vi.fn(() => null) }));
vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "http://headroom.local" }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn(async () => null) }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
import { saveUsageStats } from "../../open-sse/handlers/chatCore/requestDetail.js";

const AFFINITY_LOG_FILE = path.join(os.tmpdir(), `req-affinity-lifecycle-${process.pid}.jsonl`);
function readAffinityEvents() {
  if (!fs.existsSync(AFFINITY_LOG_FILE)) return [];
  return fs.readFileSync(AFFINITY_LOG_FILE, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
async function pumpStream(response) {
  if (!response?.body) return;
  const reader = response.body.getReader();
  while (true) { const { done } = await reader.read(); if (done) break; }
}
async function runStreamingChat({ executorImpl, bodyOverride = {}, onConfigure }) {
  process.env.AFFINITY_LOG_FILE = AFFINITY_LOG_FILE;
  process.env.ENABLE_AFFINITY_LOG = "1";
  fs.rmSync(AFFINITY_LOG_FILE, { force: true });
  vi.resetModules();
  lifecycleMocks.getSettings.mockResolvedValue({ requireApiKey: false, comboStrategy: "fallback", comboStrategies: {}, comboStickyRoundRobinLimit: 1 });
  lifecycleMocks.getComboModels.mockResolvedValue(null);
  lifecycleMocks.getModelInfo.mockResolvedValue({ provider: "openai", model: "gpt-4o" });
  lifecycleMocks.checkAndRefreshToken.mockImplementation(async (_p, creds) => creds);
  lifecycleMocks.getProviderCredentials.mockResolvedValue({ connectionId: "conn-a", connectionName: "Acc A", providerSpecificData: {} });
  lifecycleMocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false });
  if (onConfigure) onConfigure();
  vi.doMock("../../open-sse/executors/index.js", () => ({
    getExecutor: () => ({ noAuth: true, execute: async () => executorImpl ? executorImpl({}) : { response: new Response("ok", { status: 200 }) } }),
  }));
  vi.doMock("../../src/lib/affinityLogger.js", async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, logAffinity: async (event, details = {}) => {
      fs.mkdirSync(path.dirname(AFFINITY_LOG_FILE), { recursive: true });
      fs.appendFileSync(AFFINITY_LOG_FILE, `${JSON.stringify({ event, ...details })}\n`);
      return true;
    } };
  });
  const { handleChat } = await import("../../src/sse/handlers/chat.js");
  const request = new Request("https://router.test/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-session-id": "sess-lifecycle" },
    body: JSON.stringify({ model: "openai/gpt-4o", stream: true, messages: [{ role: "user", content: "hi" }], ...bodyOverride }),
  });
  return handleChat(request);
}
function sseResponse(chunks) { return throwingSseResponse(chunks, { closeInsteadOfError: true }); }
function throwingSseResponse(chunks, { closeInsteadOfError = false } = {}) {
  const encoder = new TextEncoder();
  const iter = chunks[Symbol.iterator]();
  const body = new ReadableStream({
    pull(controller) {
      const { value, done } = iter.next();
      if (done) { if (closeInsteadOfError) controller.close(); else controller.error(new Error("socket hang up")); }
      else controller.enqueue(encoder.encode(value));
    },
    cancel() {},
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("affinity lifecycle (real handler flow, AFFINITY_LOG_FILE capture)", () => {
  beforeEach(() => { process.env.AFFINITY_LOG_FILE = AFFINITY_LOG_FILE; delete process.env.ENABLE_AFFINITY_LOG; });
  afterEach(() => { delete process.env.AFFINITY_LOG_FILE; delete process.env.ENABLE_AFFINITY_LOG; fs.rmSync(AFFINITY_LOG_FILE, { force: true }); vi.resetModules(); });
  it("streaming Response returned before EOF: no affinity.request yet", async () => {
    const response = await runStreamingChat({ executorImpl: async () => ({ response: sseResponse(["data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n\n"]) }) });
    expect(response.status).toBe(200);
    expect(readAffinityEvents().filter((e) => e.event === "affinity.request")).toHaveLength(0);
  });
  it("clean EOF -> exactly one affinity.request with normalized cached/input/output tokens", async () => {
    const response = await runStreamingChat({ executorImpl: async () => ({ response: sseResponse([
      "data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n\n",
      "data: {\"choices\":[{\"delta\":{\"content\":\"y\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":7,\"prompt_tokens_details\":{\"cached_tokens\":40}}}\n\n",
      "data: [DONE]\n\n",
    ]) }) });
    await pumpStream(response);
    const events = readAffinityEvents().filter((e) => e.event === "affinity.request");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: 200, finalized: true });
    expect(events[0].usage).toEqual({ inputTokens: 100, cachedTokens: 40, cacheCreationTokens: null, outputTokens: 7 });
  });
  it("stream error/disconnect -> one affinity.request with usage null, no second race", async () => {
    const response = await runStreamingChat({ executorImpl: async () => ({ response: throwingSseResponse(["data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n\n"]) }) });
    await pumpStream(response).catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    const events = readAffinityEvents().filter((e) => e.event === "affinity.request");
    expect(events).toHaveLength(1);
    expect(events[0].usage).toBeNull();
  });
  it("non-streaming abort finalizes with final response status (not 502)", async () => {
    const response = await runStreamingChat({ bodyOverride: { stream: false }, executorImpl: async () => { throw new DOMException("aborted", "AbortError"); } });
    expect(response.status).toBe(499);
    const events = readAffinityEvents().filter((e) => e.event === "affinity.request");
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe(499);
  });
  it("streaming empty upstream body: finalizes once with status 200 usage null", async () => {
    const response = await runStreamingChat({ executorImpl: async () => ({ response: sseResponse([]) }) });
    await pumpStream(response);
    const events = readAffinityEvents().filter((e) => e.event === "affinity.request");
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe(200);
    expect(events[0].usage).toBeNull();
  });
});
describe("affinity usage finalizer", () => {
  it("normalizes cache usage then finalizes exactly once", () => {
    const diagnostics = { finalized: false, usage: null }; const finalize = vi.fn(({ usage }) => { if (diagnostics.finalized) return; diagnostics.finalized = true; diagnostics.usage = usage; });
    saveUsageStats({ provider: "codex", model: "x", tokens: { input_tokens: 10, output_tokens: 3, cached_tokens: 7 }, affinityDiagnostics: diagnostics, finalizeAffinityRequest: finalize, silent: true });
    saveUsageStats({ provider: "codex", model: "x", tokens: { input_tokens: 10, output_tokens: 3, cached_tokens: 7 }, affinityDiagnostics: diagnostics, finalizeAffinityRequest: finalize, silent: true });
    expect(finalize).toHaveBeenCalledTimes(1); expect(diagnostics.usage).toEqual({ inputTokens: 10, cachedTokens: 7, cacheCreationTokens: null, outputTokens: 3 });
  });
  it("keeps absent cache usage null after canonicalization", () => {
    const diagnostics = { finalized: false, usage: null }; const finalize = vi.fn(({ usage }) => { diagnostics.finalized = true; diagnostics.usage = usage; });
    saveUsageStats({ provider: "x", model: "x", tokens: { input_tokens: 10, output_tokens: 3 }, affinityDiagnostics: diagnostics, finalizeAffinityRequest: finalize, silent: true });
    expect(diagnostics.usage).toEqual({ inputTokens: 10, cachedTokens: null, cacheCreationTokens: null, outputTokens: 3 });
  });
  it("does not invent usage for missing values", () => {
    const finalize = vi.fn(); saveUsageStats({ provider: "x", model: "x", tokens: null, finalizeAffinityRequest: finalize, affinityDiagnostics: {} }); expect(finalize).not.toHaveBeenCalled();
  });
});
