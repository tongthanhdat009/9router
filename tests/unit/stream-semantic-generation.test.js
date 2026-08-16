import { describe, expect, it } from "vitest";
import { hasSemanticGenerationDelta } from "../../open-sse/utils/streamHelpers.js";

describe("semantic generation delta", () => {
  it("accepts generated text, reasoning, tools, Claude thinking, and Gemini text", () => {
    expect(hasSemanticGenerationDelta({ choices: [{ delta: { content: "x" } }] })).toBe(true);
    expect(hasSemanticGenerationDelta({ choices: [{ delta: { reasoning_content: "x" } }] })).toBe(true);
    expect(hasSemanticGenerationDelta({ choices: [{ delta: { tool_calls: [{ function: { arguments: "{}" } }] } }] })).toBe(true);
    expect(hasSemanticGenerationDelta({ delta: { thinking: "x" } })).toBe(true);
    expect(hasSemanticGenerationDelta({ candidates: [{ content: { parts: [{ text: "x" }] } }] })).toBe(true);
  });

  it("rejects framing, usage, finish, and empty tool deltas", () => {
    expect(hasSemanticGenerationDelta({ choices: [{ delta: { role: "assistant" } }] })).toBe(false);
    expect(hasSemanticGenerationDelta({ choices: [{ finish_reason: "stop", delta: {} }] })).toBe(false);
    expect(hasSemanticGenerationDelta({ usage: { completion_tokens: 64 } })).toBe(false);
    expect(hasSemanticGenerationDelta({ choices: [{ delta: { tool_calls: [] } }] })).toBe(false);
  });
});

import { hasOpenAIResponsesSemanticGenerationDelta } from "../../open-sse/utils/streamHelpers.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSEStream } from "../../open-sse/utils/stream.js";

describe("OpenAI Responses same-format semantic generation", () => {
  it("accepts Responses semantic delta events with non-empty delta", () => {
    expect(hasOpenAIResponsesSemanticGenerationDelta("response.output_text.delta", { type: "response.output_text.delta", delta: "x" })).toBe(true);
    expect(hasOpenAIResponsesSemanticGenerationDelta("response.refusal.delta", { delta: "x" })).toBe(true);
    expect(hasOpenAIResponsesSemanticGenerationDelta("response.reasoning_summary_text.delta", { delta: "x" })).toBe(true);
    expect(hasOpenAIResponsesSemanticGenerationDelta("response.function_call_arguments.delta", { delta: "{}" })).toBe(true);
    expect(hasOpenAIResponsesSemanticGenerationDelta("response.custom_tool_call_input.delta", { delta: "x" })).toBe(true);
    // type field alone identifies the event when no event: frame was captured
    expect(hasOpenAIResponsesSemanticGenerationDelta(null, { type: "response.output_text.delta", delta: "x" })).toBe(true);
  });

  it("rejects framing/terminal events and empty deltas", () => {
    expect(hasOpenAIResponsesSemanticGenerationDelta("response.created", { response: { status: "in_progress" } })).toBe(false);
    expect(hasOpenAIResponsesSemanticGenerationDelta("response.output_item.added", { item: {} })).toBe(false);
    expect(hasOpenAIResponsesSemanticGenerationDelta("response.completed", { response: { status: "completed" } })).toBe(false);
    expect(hasOpenAIResponsesSemanticGenerationDelta("response.output_text.delta", { delta: "" })).toBe(false);
    expect(hasOpenAIResponsesSemanticGenerationDelta("response.output_text.delta", {})).toBe(false);
    expect(hasOpenAIResponsesSemanticGenerationDelta(null, {})).toBe(false);
  });

  it("captures firstSemanticGenerationAt in native Responses passthrough", async () => {
    const encoder = new TextEncoder();
    let completed = null;
    const before = Date.now();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode([
          "event: response.output_text.delta",
          `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "partial" })}`,
          "",
          "data: [DONE]",
          "",
        ].join("\n")));
        controller.close();
      },
    }).pipeThrough(createSSEStream({
      mode: "passthrough",
      provider: "codex",
      model: "gpt-5.5",
      onStreamComplete: (content, usage, ttftAt, firstSemanticGenerationAt) => { completed = { firstSemanticGenerationAt }; },
    }));

    const reader = stream.getReader();
    while (!(await reader.read()).done) { /* drain */ }

    expect(completed?.firstSemanticGenerationAt).toBeGreaterThanOrEqual(before);
    expect(completed?.firstSemanticGenerationAt).toBeLessThanOrEqual(Date.now());
  });

  it("captures firstSemanticGenerationAt in same-format Responses passthrough and reports it via onStreamComplete", async () => {
    const encoder = new TextEncoder();
    const input = [
      "event: response.created",
      `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_test", status: "in_progress" } })}`,
      "",
      "event: response.output_text.delta",
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "partial" })}`,
      "",
      "event: response.completed",
      `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_test", status: "completed", usage: { input_tokens: 10, output_tokens: 5 } } })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    let completed = null;
    const before = Date.now();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(input));
        controller.close();
      },
    }).pipeThrough(
      createSSEStream({
        mode: "translate",
        targetFormat: FORMATS.OPENAI_RESPONSES,
        sourceFormat: FORMATS.OPENAI_RESPONSES,
        provider: "codex",
        model: "gpt-5.5",
        onStreamComplete: (content, usage, ttftAt, firstSemanticGenerationAt) => {
          completed = { usage, firstSemanticGenerationAt };
        },
      }),
    );

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();

    // Passthrough framing preserved
    expect(text).toContain("event: response.output_text.delta");
    expect(text).toContain('\"delta\":\"partial\"');

    // Semantic generation timestamp captured on the same-format path
    expect(completed).not.toBe(null);
    expect(completed.firstSemanticGenerationAt).toBeGreaterThanOrEqual(before);
    expect(completed.firstSemanticGenerationAt).toBeLessThanOrEqual(Date.now());
  });
});
