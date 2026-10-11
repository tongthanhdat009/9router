/**
 * Empty-success guard: content-less SSE with no tool calls parses to null
 * so callers map it to 502 and the account/combo loop falls back instead
 * of binding affinity to the empty member. Toolcall-only and content
 * streams stay success.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {})
}));

const { parseSSEToOpenAIResponse } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");

const SSE = (lines) => lines.join("\n\n");

describe("empty SSE collapses to null (callers map to 502)", () => {
  it("returns null for content-less chunks with no tool calls", () => {
    const raw = SSE([
      'data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]"
    ]);
    expect(parseSSEToOpenAIResponse(raw, "m")).toBeNull();
  });

  it("keeps toolcall-only streams as success", () => {
    const raw = SSE([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"exec","arguments":"{}"}}]},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      "data: [DONE]"
    ]);
    const parsed = parseSSEToOpenAIResponse(raw, "m");
    expect(parsed.choices[0].message.tool_calls).toHaveLength(1);
    expect(parsed.choices[0].message.content).toBeNull();
  });

  it("keeps reasoning-only streams as success (step/minimax thinking)", () => {
    const raw = SSE([
      'data: {"choices":[{"delta":{"role":"assistant","reasoning_content":"plan"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"reasoning":" more"},"finish_reason":"stop"}]}',
      "data: [DONE]"
    ]);
    const parsed = parseSSEToOpenAIResponse(raw, "step-5-preview-free");
    expect(parsed).not.toBeNull();
    expect(parsed.choices[0].message.reasoning_content).toBe("plan more");
  });

  it("keeps content streams as success", () => {
    const raw = SSE([
      'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]"
    ]);
    expect(parseSSEToOpenAIResponse(raw, "m").choices[0].message.content).toBe("hi");
  });
});

