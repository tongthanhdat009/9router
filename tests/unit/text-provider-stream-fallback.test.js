import { afterEach, describe, expect, it, vi } from "vitest";
import { BaseExecutor } from "../../open-sse/executors/base.js";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { CommandCodeExecutor } from "../../open-sse/executors/commandcode.js";

const encoder = new TextEncoder();

function streamFromText(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function mockUpstream(response) {
  return vi.spyOn(BaseExecutor.prototype, "execute").mockResolvedValue({ response });
}

afterEach(() => vi.restoreAllMocks());

describe("text provider pre-output stream failures", () => {
  it("turns Codex response.failed into a synthetic 503 account fallback", async () => {
    mockUpstream(new Response(streamFromText([
      "event: response.failed",
      'data: {"type":"response.failed","response":{"error":{"message":"account unavailable"}}}',
      "",
    ].join("\n")), { status: 200 }));

    const result = await new CodexExecutor().execute({ body: {}, model: "gpt-5", log: {} });

    expect(result.response.status).toBe(503);
    await expect(result.response.json()).resolves.toMatchObject({
      error: { message: "account unavailable" },
    });
  });

  it("turns a Command Code pre-output NDJSON error into a synthetic 503", async () => {
    mockUpstream(new Response(streamFromText('{"type":"error","error":"quota exhausted"}\n'), { status: 200 }));

    const result = await new CommandCodeExecutor().execute({ body: {}, model: "command-model" });

    expect(result.response.ok).toBe(false);
    expect(result.response.status).toBe(503);
    await expect(result.response.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining("quota exhausted") },
    });
  });

  it("turns an unterminated Command Code pre-output error into a synthetic 503", async () => {
    mockUpstream(new Response(streamFromText('{"type":"error","error":"no newline"}'), { status: 200 }));

    const result = await new CommandCodeExecutor().execute({ body: {}, model: "command-model" });

    expect(result.response.status).toBe(503);
    await expect(result.response.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining("no newline") },
    });
  });

  it("does not turn a preflight read failure into an empty successful stream", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('{"type":"start"}\n'));
        controller.error(new Error("upstream dropped"));
      },
    });
    mockUpstream(new Response(body, { status: 200 }));

    const result = await new CommandCodeExecutor().execute({ body: {}, model: "command-model" });

    await expect(result.response.text()).rejects.toThrow("upstream dropped");
  });

  it("replays normal Command Code NDJSON unchanged through the existing transform", async () => {
    mockUpstream(new Response(streamFromText([
      '{"type":"text-delta","text":"hello"}',
      '{"type":"finish","finishReason":"stop"}',
      "",
    ].join("\n")), { status: 200 }));

    const result = await new CommandCodeExecutor().execute({ body: {}, model: "command-model" });
    const body = await result.response.text();

    expect(result.response.status).toBe(200);
    expect(body).toContain('"content":"hello"');
    expect(body).toContain("data: [DONE]");
  });

  it("keeps a Command Code error after text in the committed 200 stream", async () => {
    mockUpstream(new Response(streamFromText([
      '{"type":"text-delta","text":"hello"}',
      '{"type":"error","error":"late failure"}',
      "",
    ].join("\n")), { status: 200 }));

    const result = await new CommandCodeExecutor().execute({ body: {}, model: "command-model" });
    const body = await result.response.text();

    expect(result.response.status).toBe(200);
    expect(body).toContain('"content":"hello"');
    expect(body).toContain("[CommandCode error: late failure]");
  });
});
