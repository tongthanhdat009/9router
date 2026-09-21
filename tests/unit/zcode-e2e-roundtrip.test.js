// ZCode full tool round trip through the real pipeline (mock upstream), TWO requests:
//  R1: OpenAI client + tools -> openai-to-claude -> prepareClaudeRequest -> ZcodeExecutor ->
//      mock SSE tool_use stream -> claude-to-openai chunks (tool_calls emitted).
//  R2: client submits tool result (OpenAI role:"tool") -> same real request path ->
//      upstream body asserts assistant tool_use + user tool_result with matching tool_use_id ->
//      mock SSE text stream -> final assistant content with finish_reason end_turn.
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));

import { FORMATS } from "../../open-sse/translator/formats.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { prepareClaudeRequest } from "../../open-sse/translator/formats/claude.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { clearZcodeOffpeakStateForTests } from "../../open-sse/services/offpeak/zcode.js";

const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
const { ZcodeExecutor } = await import("../../open-sse/executors/zcode.js");

const dataLine = (obj) => "data: " + JSON.stringify(obj);
const toolUseFrames = [
  "event: message_start",
  dataLine({ type: "message_start", message: { id: "msg_1", role: "assistant", model: "GLM-5.3", usage: { input_tokens: 10 } } }),
  "",
  "event: content_block_start",
  dataLine({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_abc123", name: "get_weather", input: {} } }),
  "",
  "event: content_block_delta",
  dataLine({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"city":"Hanoi"}' } }),
  "",
  "event: content_block_stop",
  dataLine({ type: "content_block_stop", index: 0 }),
  "",
  "event: message_delta",
  dataLine({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } }),
  "",
  "event: message_stop",
  dataLine({ type: "message_stop" }),
  "",
].join("\n");
const textFrames = [
  "event: message_start",
  dataLine({ type: "message_start", message: { id: "msg_2", role: "assistant", model: "GLM-5.3", usage: { input_tokens: 40 } } }),
  "",
  "event: content_block_start",
  dataLine({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  "",
  "event: content_block_delta",
  dataLine({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Weather in Hanoi: 30C" } }),
  "",
  "event: content_block_stop",
  dataLine({ type: "content_block_stop", index: 0 }),
  "",
  "event: message_delta",
  dataLine({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } }),
  "",
  "event: message_stop",
  dataLine({ type: "message_stop" }),
  "",
].join("\n");

function sseResponse(frames) {
  const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(frames)); c.close(); } });
  return { ok: true, status: 200, headers: new Headers(), body, json: () => Promise.reject(new Error("stream")), text: () => Promise.resolve(frames), clone: () => sseResponse(frames) };
}
function jsonRes(payload) {
  return { ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve(payload), text: () => Promise.resolve(JSON.stringify(payload)), clone() { return jsonRes(payload); } };
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

const CREDS = () => ({
  connectionId: "rt-conn",
  providerSpecificData: { deviceId: "dev-1", userId: "u-1", codingPlanApiKey: "df8dkey.fixture0001", zcodeJwtToken: "jwt.fixture" },
});
const GATEWAY = "https://zcode.z.ai/api/v1/ultra-zai/anthropic/v1/messages";

beforeEach(() => { vi.clearAllMocks(); clearZcodeOffpeakStateForTests(); });

describe("zcode full tool round trip through real pipeline", () => {
  it("request1 emits tool_calls; request2 carries tool_result upstream and ends with final text", async () => {
    const seenBodies = [];
    vi.mocked(proxyAwareFetch).mockImplementation(async (url, options = {}) => {
      if (url === "https://api.z.ai/api/biz/customer/getCustomerInfo") return jsonRes({ code: 401, msg: "no" });
      if (url === "https://zcode.z.ai/api/v1/zcode-plan/billing/balance") {
        return jsonRes({ code: 0, data: { configs: { offPeak: { enable_offpeak_task: true, allowed_models: ["GLM-5.3"] } } } });
      }
      if (url === "https://zcode.z.ai/api/v1/off-peak/ticket/availability") return jsonRes({ code: 0, data: { can_take_number: false } });
      if (url === GATEWAY) {
        seenBodies.push(JSON.parse(options.body));
        return sseResponse(seenBodies.length === 1 ? toolUseFrames : textFrames);
      }
      throw new Error("rt: unexpected " + options.method + " " + url);
    });

    const ex = new ZcodeExecutor();
    const tools = [{ type: "function", function: { name: "get_weather", description: "w", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } }];

    // ---- REQUEST 1: tool definition -> tool call ----
    const body1 = { messages: [{ role: "user", content: "weather in Hanoi?" }], tools, tool_choice: "auto" };
    const conv1 = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, "GLM-5.3", structuredClone(body1), true, null, "zcode");
    const final1 = prepareClaudeRequest(conv1, "zcode", "k", "rt-conn", null, "sess-1");
    const { response: resp1 } = await ex.execute({ model: "GLM-5.3", body: final1, stream: true, credentials: CREDS(), signal: null, log: null, proxyOptions: null });
    expect(resp1.ok).toBe(true);
    const text1 = await collectThrough(createSSETransformStreamWithLogger(FORMATS.CLAUDE, FORMATS.OPENAI, "zcode", null, null, "GLM-5.3"), toolUseFrames);
    expect(text1).toContain('"name":"get_weather"');
    expect(text1).toContain('city');
    expect(text1).toContain('Hanoi');
    expect(text1).toContain('"finish_reason":"tool_calls"');

    // ---- CLIENT TOOL RESULT (what an OpenAI-protocol client sends back) ----
    const body2 = {
      messages: [
        { role: "user", content: "weather in Hanoi?" },
        { role: "assistant", content: null, tool_calls: [{ id: "toolu_abc123", type: "function", function: { name: "get_weather", arguments: '{"city":"Hanoi"}' } }] },
        { role: "tool", tool_call_id: "toolu_abc123", content: "30C sunny" },
      ],
      tools,
      tool_choice: "auto",
    };

    // ---- REQUEST 2: tool result -> final assistant response ----
    const conv2 = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, "GLM-5.3", structuredClone(body2), true, null, "zcode");
    const final2 = prepareClaudeRequest(conv2, "zcode", "k", "rt-conn", null, "sess-1");
    // Upstream body must keep the association: assistant tool_use id + user tool_result tool_use_id
    const asstMsg = final2.messages.find((m) => m.role === "assistant");
    expect(asstMsg.content.some((b) => b.type === "tool_use" && b.id === "toolu_abc123" && b.name === "get_weather")).toBe(true);
    const userMsg = final2.messages.find((m) => m.role === "user" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"));
    const tr = userMsg.content.find((b) => b.type === "tool_result");
    expect(tr.tool_use_id).toBe("toolu_abc123");
    expect(JSON.stringify(tr.content)).toContain("30C sunny");
    // tool_result must be its own user message right after the assistant tool_use message
    expect(final2.messages.indexOf(userMsg)).toBe(final2.messages.indexOf(asstMsg) + 1);

    const { response: resp2 } = await ex.execute({ model: "GLM-5.3", body: final2, stream: true, credentials: CREDS(), signal: null, log: null, proxyOptions: null });
    expect(resp2.ok).toBe(true);
    expect(seenBodies).toHaveLength(2);
    const text2 = await collectThrough(createSSETransformStreamWithLogger(FORMATS.CLAUDE, FORMATS.OPENAI, "zcode", null, null, "GLM-5.3"), textFrames);
    expect(text2).toContain("Weather in Hanoi: 30C");
    expect(text2).toContain('"finish_reason":"stop"');
    expect(text2).not.toContain("tool_calls");
  });
});
