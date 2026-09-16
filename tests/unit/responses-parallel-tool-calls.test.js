// Parallel tool-call indexing: two added events before any deltas must pin
// separate downstream indices (item-keyed), not collapse onto index 0.
import { describe, it, expect } from "vitest";
import { translateResponse, initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

function runStream(events) {
  const state = initState(FORMATS.OPENAI_RESPONSES);
  const all = [];
  for (const ev of events) {
    const out = translateResponse(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, ev, state);
    if (Array.isArray(out)) all.push(...out);
    else if (out) all.push(out);
  }
  return { chunks: all, state };
}

const added = (id, callId, name) => ({
  type: "response.output_item.added",
  item: { type: "function_call", id, call_id: callId, name },
});
const delta = (itemId, d) => ({
  type: "response.function_call_arguments.delta",
  item_id: itemId,
  delta: d,
});
const done = (id) => ({
  type: "response.output_item.done",
  item: { type: "function_call", id, arguments: '{"done":true}' },
});

describe("Responses parallel tool-call indexing", () => {
  it("pins two added calls to separate indices and routes deltas by item_id", () => {
    const { chunks } = runStream([
      added("fc_1", "c1", "fn1"),
      added("fc_2", "c2", "fn2"),
      delta("fc_2", '{"b":'),
      delta("fc_1", '{"a":1}'),
    ]);
    const headers = chunks.filter((c) => c.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name);
    expect(headers.map((c) => c.choices[0].delta.tool_calls[0].index)).toEqual([0, 1]);
    const argChunks = chunks.filter((c) => c.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments);
    expect(argChunks.map((c) => c.choices[0].delta.tool_calls[0].index)).toEqual([1, 0]);
  });

  it("done emits full args only when no deltas were seen, and never advances shared counter", () => {
    const { chunks, state } = runStream([
      added("fc_1", "c1", "fn1"),
      done("fc_1"),
    ]);
    const argChunks = chunks.filter((c) => c.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments);
    expect(argChunks.length).toBe(1);
    expect(state.toolCallIndex).toBe(1);
  });

  it("routes keyless delta to the sole pinned call (golden shape), drops unmatched with multiple pins", () => {
    const solo = runStream([
      { type: "response.output_item.added", item: { type: "function_call", call_id: "call_1", name: "get_weather" } },
      { type: "response.function_call_arguments.delta", delta: '{"city":"NYC"}' },
    ]);
    const soloArgs = solo.chunks.filter((c) => c.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments);
    expect(soloArgs.length).toBe(1);
    expect(soloArgs[0].choices[0].delta.tool_calls[0].index).toBe(0);
    const multi = runStream([
      added("fc_1", "c1", "fn1"),
      added("fc_2", "c2", "fn2"),
      { type: "response.function_call_arguments.delta", item_id: "fc_zzz", delta: "{}" },
    ]);
    const multiArgs = multi.chunks.filter((c) => c.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments);
    expect(multiArgs.length).toBe(0);
  });
});
