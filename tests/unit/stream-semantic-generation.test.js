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
