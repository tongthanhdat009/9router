import { describe, expect, it } from "vitest";
import { anchorClaudeCache, prepareClaudeRequest } from "../../open-sse/translator/formats/claude.js";

const markers = [
  { type: "ephemeral" },
  { type: "ephemeral", ttl: "5m" },
  { type: "ephemeral", ttl: "1h" },
];

function bodyWithMarker(area, index, cache_control) {
  const body = {
    system: [{ type: "text", text: "system-a" }, { type: "text", text: "system-b" }],
    messages: [{ role: "user", content: [{ type: "text", text: "message-a" }, { type: "text", text: "message-b" }] }],
    tools: [
      { name: "tool-a", input_schema: { type: "object" } },
      { name: "tool-b", input_schema: { type: "object" } },
    ],
  };
  const blocks = area === "message" ? body.messages[0].content : body[area];
  blocks[index].cache_control = structuredClone(cache_control);
  return body;
}

function markerAt(body, area, index) {
  return (area === "message" ? body.messages[0].content : body[area])[index].cache_control;
}

for (const [name, normalize] of [
  ["prepareClaudeRequest", body => prepareClaudeRequest(body, "claude")],
  ["anchorClaudeCache", anchorClaudeCache],
]) {
  describe(name, () => {
    for (const area of ["system", "message", "tools"]) {
      for (const index of [0, 1]) {
        for (const marker of markers) {
          it(`${area} ${index === 0 ? "non-tail" : "tail"} ${marker.ttl ?? "default-5m"}`, () => {
            const body = bodyWithMarker(area, index, marker);
            const before = structuredClone(body);
            normalize(body);
            expect(markerAt(body, area, index)).toEqual(marker);
            expect(body).toEqual(before);
          });
        }
      }
    }

    it("retains legacy automatic anchors when no marker exists", () => {
      const body = {
        system: [{ type: "text", text: "system-a" }, { type: "text", text: "system-b" }],
        messages: [
          { role: "assistant", content: [{ type: "text", text: "answer-a" }] },
          { role: "assistant", content: [{ type: "text", text: "answer-b" }] },
          { role: "user", content: [{ type: "text", text: "question" }] },
        ],
        tools: [
          { name: "tool-a", input_schema: { type: "object" } },
          { name: "tool-b", input_schema: { type: "object" } },
        ],
      };
      normalize(body);
      expect(body.system.map(block => block.cache_control)).toEqual([undefined, { type: "ephemeral", ttl: "1h" }]);
      expect(body.tools.map(tool => tool.cache_control)).toEqual([undefined, { type: "ephemeral", ttl: "1h" }]);
      expect(body.messages.flatMap(message => message.role === "assistant" ? message.content : []).at(-1).cache_control).toEqual({ type: "ephemeral" });
    });
  });
}
