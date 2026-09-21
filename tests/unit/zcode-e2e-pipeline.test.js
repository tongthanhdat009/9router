// ZCode mock-upstream E2E through the real request pipeline:
// OpenAI client body -> openai-to-claude (incl. tool_choice none fix) ->
// prepareClaudeRequest (registry quirk) -> ZcodeExecutor -> mock upstream SSE->
// claude->openai response stream to OpenAI chunks OR claude passthrough (no [DONE]).
// All network is the vi-mocked proxyAwareFetch; mock gateway asserts the new contracts.
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));

import { FORMATS } from "../../open-sse/translator/formats.js";
import { translateRequest, translateResponse, initState } from "../../open-sse/translator/index.js";
import { prepareClaudeRequest } from "../../open-sse/translator/formats/claude.js";
import { createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";
import { clearZcodeOffpeakStateForTests } from "../../open-sse/services/offpeak/zcode.js";

const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
const { ZcodeExecutor } = await import("../../open-sse/executors/zcode.js");

const dataLine = (obj) => "data: " + JSON.stringify(obj);
const SSE_FRAMES = [
  "event: message_start",
  'data: {"type":"message_start","message":{"id":"msg_1","role":"assistant","model":"GLM-5.3","usage":{"input_tokens":10}}}',
  "",
  "event: content_block_start",
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{}}}',
  "",
  "event: content_block_delta",
  dataLine({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"city":' } }),
  "",
  "event: content_block_delta",
  dataLine({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"Hanoi"}' } }),
  "",
  "event: content_block_stop",
  'data: {"type":"content_block_stop","index":0}',
  "",
  "event: message_delta",
  'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":12}}',
  "",
  "event: message_stop",
  'data: {"type":"message_stop"}',
  "",
].join("\n");

function sseResponse(frames) {
  const body = new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(frames)); c.close(); },
  });
  return { ok: true, status: 200, headers: new Headers(), body, json: () => Promise.reject(new Error("stream")), text: () => Promise.resolve(frames), clone: () => sseResponse(frames) };
}
function jsonRes(payload, status = 200) {
  return { ok: status < 400, status, headers: new Headers(), json: () => Promise.resolve(payload), text: () => Promise.resolve(JSON.stringify(payload)), clone() { return jsonRes(payload, status); } };
}

async function collectThrough(transform, frames) {
  const src = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(frames)); c.close(); } });
  const out = src.pipeThrough(transform);
  const reader = out.getReader();
  const dec = new TextDecoder();
  let text = "";
  for (;;) { const { value, done } = await reader.read(); if (done) break; text += dec.decode(value, { stream: true }); }
  return text + dec.decode();
}

const CREDS = (psd) => ({
  connectionId: "e2e-conn",
  providerSpecificData: { deviceId: "dev-1", userId: "u-1", codingPlanApiKey: "df8dkey.fixture0001", zcodeJwtToken: "jwt.fixture", ...(psd || {}) },
});

// Key-mint + ticket endpoints + inference URL assertion surface
function mockUpstream(seen) {
  return async (url, options = {}) => {
    if (url === "https://api.z.ai/api/biz/customer/getCustomerInfo") {
      return jsonRes({ code: 401, msg: "token expired or incorrect" }, 200);
    }
    if (url === "https://zcode.z.ai/api/v1/zcode-plan/billing/balance") {
      return jsonRes({ code: 0, data: { configs: { offPeak: { enable_offpeak_task: true, allowed_models: ["GLM-5.3"] } } } });
    }
    if (url === "https://zcode.z.ai/api/v1/off-peak/ticket/availability") {
      return jsonRes({ code: 0, data: { can_take_number: false } }); // force normal channel
    }
    if (url === "https://zcode.z.ai/api/v1/ultra-zai/anthropic/v1/messages") {
      seen.inference = { url, headers: options.headers, body: JSON.parse(options.body) };
      return sseResponse(SSE_FRAMES);
    }
    throw new Error("e2e: unexpected " + options.method + " " + url);
  };
}

beforeEach(() => { vi.clearAllMocks(); clearZcodeOffpeakStateForTests(); });

describe("zcode E2E through real pipeline (mock upstream)", () => {
  it("openai client tools -> gateway URL + headers -> SSE -> openai tool_call chunks", async () => {
    const seen = {};
    vi.mocked(proxyAwareFetch).mockImplementation(mockUpstream(seen));
    const clientBody = {
      messages: [{ role: "user", content: "weather?" }],
      tools: [{ type: "function", function: { name: "get_weather", description: "w", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } }],
      tool_choice: "none",
      parallel_tool_calls: false,
    };
    const converted = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, "GLM-5.3", structuredClone(clientBody), true, null, "zcode");
    expect(converted.tool_choice).toEqual({ type: "none", disable_parallel_tool_use: true });
    const final = prepareClaudeRequest(converted, "zcode", "k", "e2e-conn", null, "sess-1");
    expect(final.tools).toHaveLength(1);
    expect(final.tools[0].name).toBe("get_weather");

    const ex = new ZcodeExecutor();
    const { response } = await ex.execute({ model: "GLM-5.3", body: final, stream: true, credentials: CREDS(), signal: null, log: null, proxyOptions: null });
    expect(seen.inference.url).toBe("https://zcode.z.ai/api/v1/ultra-zai/anthropic/v1/messages");
    expect(seen.inference.headers["x-api-key"]).toBe("df8dkey.fixture0001");
    expect(String(seen.inference.headers["Authorization"])).toContain("df8dkey.fixture0001");
    expect(JSON.parse(seen.inference.body.metadata.user_id)).toMatchObject({ device_id: "dev-1" });

    const text = await collectThrough(createSSETransformStreamWithLogger(FORMATS.CLAUDE, FORMATS.OPENAI, "zcode", null, null, "GLM-5.3"), SSE_FRAMES);
    expect(text).toContain("get_weather");
    expect(text).toContain("Hanoi");
    expect(text).toContain("tool_calls");
    expect(text).toContain('"finish_reason":"tool_calls"');
  });

  it("claude client passthrough ends at message_stop with no [DONE]", async () => {
    const text = await collectThrough(createPassthroughStreamWithLogger("zcode", null, "GLM-5.3", "e2e-conn", {}, null, null, FORMATS.CLAUDE), SSE_FRAMES);
    expect(text).toContain("event: message_stop");
    expect(text).not.toContain("[DONE]");
  });

  it("native web_search tool survives prepareClaudeRequest for zcode", async () => {
    const out = prepareClaudeRequest({ model: "GLM-5.3", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }] }, "zcode");
    expect(out.tools).toHaveLength(1);
    expect(out.tools[0].type).toBe("web_search_20260209");
  });
});
