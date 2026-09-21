// OpenAI -> Claude tool_choice conversion + parallel_tool_calls mapping.
import { describe, it, expect } from "vitest";
import "./registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const TOOLS = [{ type: "function", function: { name: "f", parameters: { type: "object", properties: {} } } }];
const T = (extra) => translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, "m", { messages: [{ role: "user", content: "hi" }], tools: TOOLS, ...extra }, true, null, "anthropic-compatible-x");

describe("openai-to-claude tool_choice", () => {
  it("string none -> { type: 'none' }", () => {
    expect(T({ tool_choice: "none" }).tool_choice).toEqual({ type: "none" });
  });

  it("string auto stays auto, required maps to any", () => {
    expect(T({ tool_choice: "auto" }).tool_choice).toEqual({ type: "auto" });
    expect(T({ tool_choice: "required" }).tool_choice).toEqual({ type: "any" });
  });

  it("parallel_tool_calls:false + tool_choice auto -> disable_parallel_tool_use", () => {
    expect(T({ tool_choice: "auto", parallel_tool_calls: false }).tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
  });

  it("parallel_tool_calls:false + named tool -> { type: 'tool', name, disable_parallel_tool_use }", () => {
    expect(T({ tool_choice: { type: "function", function: { name: "f" } }, parallel_tool_calls: false }).tool_choice).toEqual({ type: "tool", name: "f", disable_parallel_tool_use: true });
  });

  it("parallel_tool_calls:false without tool_choice synthesizes auto + disable", () => {
    expect(T({ parallel_tool_calls: false }).tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
  });

  it("parallel_tool_calls:true emits no disable field", () => {
    const tc = T({ tool_choice: "auto", parallel_tool_calls: true }).tool_choice;
    expect(tc).toEqual({ type: "auto" });
    expect(tc).not.toHaveProperty("disable_parallel_tool_use");
  });

  it("does not mutate the caller's body.tool_choice", () => {
    const native = { type: "tool", name: "f" };
    const body = { messages: [{ role: "user", content: "hi" }], tools: TOOLS, tool_choice: native, parallel_tool_calls: false };
    translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, "m", body, true, null, "anthropic-compatible-x");
    expect(native).toEqual({ type: "tool", name: "f" });
  });
});
