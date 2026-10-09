/**
 * Claude Code (claude format) -> muse-spark (openai-responses) tool wiring.
 * The request pivots claude -> openai -> responses; the assistant tool_use id
 * and the tool_result tool_use_id must survive both hops as the same call_id,
 * otherwise the upstream sees an orphan function_call_output and the agent
 * re-issues the identical call every turn (client-side loop, MSG count grows).
 */
import { describe, it, expect } from "vitest";
import { claudeToOpenAIRequest } from "../../open-sse/translator/request/claude-to-openai.js";
import { openaiToOpenAIResponsesRequest } from "../../open-sse/translator/request/openai-responses.js";

const CLAUDE_BODY = {
  model: "free",
  system: "sys",
  messages: [
    { role: "user", content: "list files" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_abc123", name: "Bash", input: { command: "ls" } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_abc123", content: "a.txt" }],
    },
  ],
  tools: [{ name: "Bash", description: "run", input_schema: { type: "object", properties: {} } }],
};

describe("claude -> openai -> responses tool continuity", () => {
  it("keeps tool_use id and tool_result tool_use_id as one call_id", () => {
    const openai = claudeToOpenAIRequest("m", structuredClone(CLAUDE_BODY), true);
    const asst = openai.messages.find((m) => m.role === "assistant");
    expect(asst.tool_calls).toHaveLength(1);
    expect(asst.tool_calls[0].id).toBe("toolu_abc123");
    const tool = openai.messages.find((m) => m.role === "tool");
    expect(tool.tool_call_id).toBe("toolu_abc123");

    const resp = openaiToOpenAIResponsesRequest("m", { ...openai, tools: openai.tools }, true, null);
    const fc = resp.input.find((i) => i.type === "function_call");
    const out = resp.input.find((i) => i.type === "function_call_output");
    expect(fc.call_id).toBe("toolu_abc123");
    expect(out.call_id).toBe("toolu_abc123");
    expect(out.call_id).toBe(fc.call_id);
  });
});
