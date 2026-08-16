// Request-scoped session context: retries keep identical identity; concurrent
// identical-body requests get distinct ids; no singleton cross-write.
import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { BaseExecutor } = await import("../../open-sse/executors/base.js");
const { CodexExecutor } = await import("../../open-sse/executors/codex.js");
const { GrokCliExecutor, _resetGrokCliTurnStore } = await import("../../open-sse/executors/grok-cli.js");
const { OpenCodeExecutor } = await import("../../open-sse/executors/opencode.js");

function res(status, headers = {}) {
  return { status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k] ?? "" } };
}

const creds = { apiKey: "k", connectionId: "conn-1", rawHeaders: {} };

// Header snapshot per fetch call (2nd arg init.headers)
const capturedHeaders = () => fetchMock.mock.calls.map((c) => c[1].headers);

beforeEach(() => {
  fetchMock.mockReset();
  _resetGrokCliTurnStore();
});

describe("grok-cli — request-scoped identity across retries", () => {
  it("same logical request: 2 retry passes → identical session/req/turn ids", async () => {
    const ex = new GrokCliExecutor();
    fetchMock
      .mockResolvedValueOnce(res(502))
      .mockResolvedValueOnce(res(200));
    await ex.execute({
      model: "grok-build",
      body: { model: "grok-build", input: [{ type: "message", role: "user", content: "hi" }], stream: true },
      stream: true,
      credentials: { ...creds, providerSpecificData: { deviceId: "dev-1" } },
      requestId: "req-A",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const h = capturedHeaders();
    const keys = ["x-grok-session-id", "x-grok-conv-id", "x-grok-req-id", "x-grok-turn-idx", "x-grok-agent-id"];
    for (const k of keys) expect(h[0][k]).toBe(h[1][k]);
    expect(h[0]["x-grok-agent-id"]).toBe("dev-1");
  });

  it("interleaved requests keep each retry pass in its own ctx", async () => {
    const ex = new GrokCliExecutor();
    let releaseA;
    const aFirst = new Promise((resolve) => { releaseA = resolve; });
    fetchMock
      .mockImplementationOnce(() => aFirst)
      .mockResolvedValueOnce(res(200))
      .mockResolvedValueOnce(res(502))
      .mockResolvedValueOnce(res(200));
    const body = (sessionId) => ({ model: "grok-build", prompt_cache_key: sessionId, input: [{ type: "message", role: "user", content: "hi" }], stream: true });
    const requestA = ex.execute({ model: "grok-build", body: body("session-A"), stream: true, credentials: { apiKey: "k" }, requestId: "req-A" });
    await Promise.resolve();
    await ex.execute({ model: "grok-build", body: body("session-B"), stream: true, credentials: { apiKey: "k" }, requestId: "req-B" });
    releaseA(res(502));
    await requestA;
    const h = capturedHeaders();
    expect(h[0]["x-grok-session-id"]).toBe("session-A");
    expect(h[1]["x-grok-session-id"]).toBe("session-B");
    expect(h[2]["x-grok-session-id"]).toBe("session-A");
    expect(h[2]["x-grok-req-id"]).toBe("req-A");
  });

  it("identical-body concurrent fallback requests mint distinct session and req ids", async () => {
    const ex = new GrokCliExecutor();
    fetchMock.mockResolvedValue(res(200));
    const body = () => ({ model: "grok-build", input: [{ type: "message", role: "user", content: "hi" }], stream: true });
    await Promise.all([
      ex.execute({ model: "grok-build", body: body(), stream: true, credentials: { apiKey: "k" } }),
      ex.execute({ model: "grok-build", body: body(), stream: true, credentials: { apiKey: "k" } }),
    ]);
    const h = capturedHeaders();
    expect(h[0]["x-grok-session-id"]).not.toBe(h[1]["x-grok-session-id"]);
    expect(h[0]["x-grok-req-id"]).not.toBe(h[1]["x-grok-req-id"]);
  });

  it("fallback UUID session minted once, stable across retries (same logical request)", async () => {
    const ex = new GrokCliExecutor();
    fetchMock.mockResolvedValueOnce(res(502)).mockResolvedValueOnce(res(200));
    await ex.execute({
      model: "grok-build",
      body: { model: "grok-build", input: [{ type: "message", role: "user", content: "hi" }], stream: true },
      stream: true,
      credentials: { apiKey: "k" }, // no connectionId → UUID fallback
      requestId: "req-A",
    });
    const h = capturedHeaders();
    expect(h[0]["x-grok-session-id"]).toBe(h[1]["x-grok-session-id"]);
    expect(h[0]["x-grok-req-id"]).toBe("req-A");
    expect(h[0]["x-grok-req-id"]).toBe("req-A");
  });
});

describe("codex — prompt_cache_key stable across retries", () => {
  it("same body: 2 retry passes → identical session_id header + prompt_cache_key body", async () => {
    const ex = new CodexExecutor();
    // subsequent responses: plain 200 with no SSE body (peek skips)
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(res(502))
      .mockResolvedValue({ status: 200, ok: true, headers: { get: () => "" }, body: null });
    await ex.execute({
      model: "gpt-5-codex",
      body: { model: "gpt-5-codex", input: [{ type: "message", role: "user", content: "hi" }], stream: true },
      stream: true,
      credentials: { ...creds, providerSpecificData: { workspaceId: "ws-1" } },
      requestId: "req-A",
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    const h = capturedHeaders();
    expect(h[0]["session_id"]).toBe(h[h.length - 1]["session_id"]);
    const bodies = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body));
    expect(bodies[0].prompt_cache_key).toBe(bodies[bodies.length - 1].prompt_cache_key);
  });
});

describe("opencode — request-scoped session", () => {
  it("same body: 2 retry passes → identical x-opencode-session", async () => {
    const ex = new OpenCodeExecutor();
    fetchMock.mockResolvedValueOnce(res(502)).mockResolvedValue(res(200));
    await ex.execute({
      model: "grok-4",
      body: { model: "grok-4", messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { ...creds },
      requestId: "req-A",
    });
    const h = capturedHeaders();
    expect(h[0]["x-opencode-session"]).toBe(h[1]["x-opencode-session"]);
    expect(h[0]["x-opencode-session"]).toMatch(/^ses_[0-9a-f]+$/);
  });
});

describe("base — ctx threading contract", () => {
  it("deriveRequestContext called once per execute entry, ctx reaches buildHeaders", async () => {
    const calls = [];
    class Probe extends BaseExecutor {
      deriveRequestContext(tb, cr, { requestId }) { calls.push({ requestId }); return { tag: `ctx-${requestId}` }; }
      buildHeaders(cr, st, url, model, ctx) { this._seen = ctx; return { "x-probe": ctx?.tag || "none" }; }
    }
    const ex = new Probe("test", { baseUrl: "https://x/api", retry: { 502: { attempts: 1, delayMs: 0 } } });
    fetchMock.mockResolvedValueOnce(res(502)).mockResolvedValue(res(200));
    await ex.execute({ model: "m", body: { a: 1 }, stream: false, credentials: creds, requestId: "req-Z" });
    expect(calls.length).toBe(1); // once per execute entry despite retry
    expect(calls[0].requestId).toBe("req-Z");
    const h = capturedHeaders();
    expect(h[0]["x-probe"]).toBe("ctx-req-Z");
    expect(h[1]["x-probe"]).toBe("ctx-req-Z");
  });
});
