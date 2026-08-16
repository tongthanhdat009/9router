import { describe, expect, it, vi, beforeEach } from "vitest";
import { executeCodexWs, wsUrl } from "../../open-sse/executors/codexWsTransport.js";

vi.mock("../../open-sse/executors/codexWsTransport.js", () => ({
  executeCodexWs: vi.fn(),
  wsUrl: url => url.replace(/^http:/, "ws:").replace(/^https:/, "wss:"),
  WsConnectError: class WsConnectError extends Error {},
  WsStreamError: class WsStreamError extends Error { constructor(message, framesEmitted = 0) { super(message); this.framesEmitted = framesEmitted; } },
}));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";

// executor.config.retry may disable 503 retries (attempts=0) so WS transient
// errors return 503 immediately instead of falling through to the HTTP loop.
function makeExecutor(retry503) {
  const executor = new CodexExecutor();
  executor.config = { ...executor.config, retry: { 503: retry503 } };
  return executor;
}

function sseResponseFromText(text, { status = 200, headers = { "content-type": "text/event-stream" } } = {}) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  return new Response(stream, { status, headers });
}

const args = () => ({
  model: "gpt-5",
  body: { model: "gpt-5", input: "hi" },
  stream: true,
  credentials: { accessToken: "token", connectionId: "conn_1" },
  signal: new AbortController().signal,
  log: { debug: vi.fn(), warn: vi.fn() },
  requestId: "req_1",
  codexUpstreamWebsocket: true,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Codex WS path SSE error rotation", () => {
  it("returns 503 account-fallback when WS stream carries response.failed (usage_limit_reached) before output", async () => {
    const executor = makeExecutor({ attempts: 3, delayMs: 0 });
    const text = [
      "event: response.created",
      'data: {"type":"response.created","response":{"id":"resp_1"}}',
      "",
      "event: response.failed",
      'data: {"type":"response.failed","response":{"error":{"code":"usage_limit_reached","message":"You\'re approaching your usage limit."}}}',
      "",
    ].join("\n");
    executeCodexWs.mockResolvedValueOnce(sseResponseFromText(text));
    const result = await executor.execute(args());
    expect(result.response.status).toBe(503);
    const body = await result.response.json();
    expect(body.error.message).toContain("usage limit");
    expect(executeCodexWs).toHaveBeenCalledTimes(1);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("returns 503 for transient marker when 503 retries are disabled (attempts=0)", async () => {
    const executor = makeExecutor({ attempts: 0, delayMs: 0 });
    const text = [
      "event: error",
      'data: {"type":"error","code":"server_is_overloaded"}',
      "",
    ].join("\n");
    executeCodexWs.mockResolvedValueOnce(sseResponseFromText(text));
    const result = await executor.execute(args());
    expect(result.response.status).toBe(503);
    await result.response.text();
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("falls through to HTTP retry loop when transient marker and retries budgeted", async () => {
    const executor = makeExecutor({ attempts: 3, delayMs: 0 });
    const wsText = [
      'data: {"error":{"code":"server_is_overloaded","message":"server overloaded"}}',
      "",
    ].join("\n");
    executeCodexWs.mockResolvedValueOnce(sseResponseFromText(wsText));
    proxyAwareFetch.mockResolvedValueOnce(sseResponseFromText("event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"OK\"}\n\n"));
    const result = await executor.execute(args());
    expect(result.response.status).toBe(200);
    const body = await result.response.text();
    expect(body).toContain("response.output_text.delta");
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    // HTTP fallback happened exactly once — transient WS error must not re-enter WS.
    expect(executeCodexWs).toHaveBeenCalledTimes(1);
  });

  it("falls back to HTTP once when WS connect fails (regression guard)", async () => {
    const executor = makeExecutor({ attempts: 3, delayMs: 0 });
    const { WsConnectError } = await import("../../open-sse/executors/codexWsTransport.js");
    executeCodexWs.mockRejectedValueOnce(new WsConnectError("connect refused"));
    proxyAwareFetch.mockResolvedValueOnce(sseResponseFromText("event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"OK\"}\n\n"));
    const result = await executor.execute(args());
    expect(result.response.status).toBe(200);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(executeCodexWs).toHaveBeenCalledTimes(1);
  });
});
