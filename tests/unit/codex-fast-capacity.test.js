import { describe, expect, it } from "vitest";
import { CodexExecutor } from "../../open-sse/executors/codex.js";

function streamFromText(text) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

describe("Codex fast tier and capacity handling", () => {
  it("maps Codex fast tier to priority and max reasoning to xhigh", () => {
    const executor = new CodexExecutor();
    const body = executor.transformRequest("gpt-5.5", {
      model: "gpt-5.5",
      input: "hi",
      reasoning_effort: "max",
      service_tier: "fast",
    }, true, {});

    expect(body.service_tier).toBe("priority");
    expect(body.reasoning.effort).toBe("xhigh");
  });

  it("uses ChatGPT workspace header fallback", () => {
    const executor = new CodexExecutor();
    const headers = executor.buildHeaders({
      accessToken: "token",
      connectionId: "conn_1",
      providerSpecificData: { chatgptAccountId: "acct_1" },
    });

    expect(headers["ChatGPT-Account-ID"]).toBe("acct_1");
  });

  it("passes normal SSE through unchanged", async () => {
    const executor = new CodexExecutor();
    const text = [
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"OK"}',
      "",
    ].join("\n");
    const response = new Response(streamFromText(text), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const peek = await executor._peekSseTransientError(response);
    expect(peek.replacementBody).toBeInstanceOf(ReadableStream);
    await expect(new Response(peek.replacementBody).text()).resolves.toBe(text);
  });
});

describe("Codex SSE transient error surfacing", () => {
  it.each([
    ["server_is_overloaded", "server_is_overloaded"],
    ["service_unavailable_error", "service_unavailable_error"],
    ["selected model is at capacity", "model_at_capacity"],
  ])("surfaces 200-OK SSE marker %s as 503 (not truncated)", async (marker, expectedMatch) => {
    const executor = new CodexExecutor();
    const text = ["event: error", `data: {"type":"error","code":"${marker}"}`, ""].join("\n");
    const response = new Response(streamFromText(text), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const peek = await executor._peekSseTransientError(response);
    expect(peek.matched).toBeTruthy();
    expect(peek.replacementBody).toBeNull();
  });

  it("passes through a same-chunk output-then-failed stream (error marker after output)", async () => {
    const executor = new CodexExecutor();
    const text = [
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"partial"}',
      "",
      "event: response.failed",
      'data: {"type":"response.failed","response":{"error":{"message":"boom"}}}',
      "",
    ].join("\n");
    const response = new Response(streamFromText(text), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const peek = await executor._peekSseTransientError(response);
    expect(peek.matched).toBeNull();
    expect(peek.accountFallback).toBe(false);
    expect(peek.replacementBody).toBeInstanceOf(ReadableStream);
    await expect(new Response(peek.replacementBody).text()).resolves.toBe(text);
  });

  it("passes through output-then-capacity in the same chunk without rotating", async () => {
    const executor = new CodexExecutor();
    const text = [
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"partial"}',
      "",
      "event: error",
      'data: {"type":"error","code":"model_at_capacity"}',
      "",
    ].join("\n");
    const response = new Response(streamFromText(text), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const peek = await executor._peekSseTransientError(response);
    expect(peek.matched).toBeNull();
    expect(peek.accountFallback).toBe(false);
    await expect(new Response(peek.replacementBody).text()).resolves.toBe(text);
  });

  it("passes through a refusal before a same-chunk capacity error", async () => {
    const executor = new CodexExecutor();
    const text = [
      "event: response.refusal.delta",
      'data: {"type":"response.refusal.delta","delta":"cannot comply"}',
      "",
      "event: error",
      'data: {"type":"error","code":"model_at_capacity"}',
      "",
    ].join("\n");
    const response = new Response(streamFromText(text), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const peek = await executor._peekSseTransientError(response);
    expect(peek.matched).toBeNull();
    await expect(new Response(peek.replacementBody).text()).resolves.toBe(text);
  });

  it("surfaces a pre-output response.failed in a later chunk as fallback (not passthrough)", async () => {
    const executor = new CodexExecutor();
    const encoder = new TextEncoder();
    const chunks = [
      ["event: response.created", 'data: {"type":"response.created"}', ""].join("\n"),
      ["event: response.failed", 'data: {"type":"response.failed","response":{"error":{"message":"boom"}}}', ""].join("\n"),
    ];
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(chunks[0]));
        controller.enqueue(encoder.encode(chunks[1]));
        controller.close();
      },
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } });

    const peek = await executor._peekSseTransientError(response);
    expect(peek.matched).toBe("response.failed");
    expect(peek.accountFallback).toBe(true);
    expect(peek.replacementBody).toBeNull();
  });

  it("returns 503 for capacity marker via codexSseErrorResponse path", async () => {
    const executor = new CodexExecutor();
    const text = [
      "event: error",
      'data: {"type":"error","code":"selected model is at capacity"}',
      "",
    ].join("\n");
    const response = new Response(streamFromText(text), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const peek = await executor._peekSseTransientError(response);
    expect(peek.accountFallback).toBe(true);
    expect(peek.matched).toBeTruthy();
    expect(peek.replacementBody).toBeNull();
  });
});

describe("Codex reasoning normalization", () => {
  it.each([
    ["gpt-5.6-sol", "max", "max"],
    ["gpt-5.6-sol", "ultra", "ultra"],
    ["gpt-5.6-terra", "max", "max"],
    ["gpt-5.6-terra", "ultra", "ultra"],
    ["gpt-5.6-luna", "max", "max"],
    ["gpt-5.6-luna", "ultra", "max"],
  ])("normalizes %s effort %s to %s", (model, effort, expected) => {
    const body = new CodexExecutor().transformRequest(model, {
      model,
      input: "hi",
      reasoning: { effort },
    }, true, {});

    expect(body.reasoning.effort).toBe(expected);
  });

  it("resolves review models before applying the reasoning matrix", () => {
    const body = new CodexExecutor().transformRequest("gpt-5.6-terra-review", {
      model: "gpt-5.6-terra-review",
      input: "hi",
      reasoning_effort: "ultra",
    }, true, {});

    expect(body.model).toBe("gpt-5.6-terra");
    expect(body.reasoning.effort).toBe("ultra");
  });
});
