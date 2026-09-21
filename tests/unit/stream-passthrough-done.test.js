// Passthrough [DONE] sentinel must match the CLIENT format, not the provider.
// Claude-protocol clients (zcode/glm/... passthrough) terminate on message_stop;
// appending "data: [DONE]" corrupts their stream (ZCode bug).
import { describe, expect, it } from "vitest";
import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

async function drain(provider, clientFormat, frames) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(frames.join("\n")));
      controller.close();
    },
  }).pipeThrough(createPassthroughStreamWithLogger(provider, null, "m", "c", {}, null, null, clientFormat));
  return await new Response(stream).text();
}

const CLAUDE_FRAMES = [
  "event: message_start",
  'data: {"type":"message_start","message":{"id":"msg_1"}}',
  "",
  "event: content_block_delta",
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
  "",
  "event: message_stop",
  'data: {"type":"message_stop"}',
  "",
];

describe("passthrough [DONE] per client format", () => {
  it("claude client: no [DONE] after message_stop", async () => {
    const text = await drain("zcode", FORMATS.CLAUDE, CLAUDE_FRAMES);
    expect(text).toContain("event: message_stop");
    expect(text).not.toContain("data: [DONE]");
  });

  it("openai client: still ends with [DONE] (OpenClaw regression guard)", async () => {
    const text = await drain("openai", FORMATS.OPENAI, [
      'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}]}',
      "",
    ]);
    expect(text.trim().endsWith("data: [DONE]")).toBe(true);
    expect(text.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  it("legacy caller without clientFormat: openai framing keeps [DONE]", async () => {
    const text = await drain("openai", null, [
      'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}]}',
      "",
    ]);
    expect(text).toContain("data: [DONE]");
  });
});
