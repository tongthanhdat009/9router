import { describe, expect, it } from "vitest";
import { cleanJSONSchemaForAntigravity, isAntigravitySchemaClean } from "../../open-sse/translator/formats/gemini.js";
import { openaiToGeminiCLIRequest } from "../../open-sse/translator/request/openai-to-gemini.js";

describe("Batch 3 performance guards", () => {
  it("single schema walk preserves Antigravity cleanup", () => {
    const schema = {
      allOf: [{ properties: { fromAllOf: { const: 3 } }, required: ["fromAllOf"] }],
      properties: {
        mode: { enum: [1, true], default: "x" },
        nested: { properties: { kept: { type: ["null", "string"], "x-ui": 1 } }, required: ["gone"] },
      },
      required: ["mode", "missing"],
      anyOf: [{ type: "null" }, { type: "object", properties: { selected: { type: "string" } } }],
      additionalProperties: false,
    };
    expect(cleanJSONSchemaForAntigravity(schema)).toEqual({
      type: "object",
      properties: { selected: { type: "string" } },
    });
  });

  it("marks cleaned schemas for executor dedup without serializing metadata", () => {
    const schema = cleanJSONSchemaForAntigravity({ type: "object", properties: { p: { const: 1 } } });
    expect(isAntigravitySchemaClean(schema)).toBe(true);
    expect(isAntigravitySchemaClean(structuredClone(schema))).toBe(false);
    expect(JSON.stringify(schema)).toBe('{"type":"object","properties":{"p":{"enum":["1"],"type":"string"}}}');
  });

  it("Gemini CLI uses the schema cleaned by the base translator", () => {
    const out = openaiToGeminiCLIRequest("m", {
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { type: "function", function: { name: "x", parameters: { type: "object", properties: { p: { const: 1 } } } } },
      ],
    });
    expect(out.tools[0].functionDeclarations[0].parameters).toEqual({
      type: "object",
      properties: { p: { enum: ["1"], type: "string" } },
    });
  });
  it("empty properties maps stay maps while orphan schemas still get placeholders", () => {
    const placeholder = {
      type: "object",
      properties: { reason: { type: "string", description: "Brief explanation of why you are calling this tool" } },
      required: ["reason"],
    };
    expect(cleanJSONSchemaForAntigravity({ type: "object", properties: {} })).toEqual({
      type: "object",
      properties: {},
    });
    expect(cleanJSONSchemaForAntigravity({})).toEqual(placeholder);
    expect(cleanJSONSchemaForAntigravity({ type: "object" })).toEqual(placeholder);
    expect(
      cleanJSONSchemaForAntigravity({ type: "object", properties: { p: {} } }).properties.p
    ).toEqual(placeholder);
    expect(
      cleanJSONSchemaForAntigravity({ type: "object", properties: { n: { type: "object", properties: {} } } })
    ).toEqual({ type: "object", properties: { n: { type: "object", properties: {} } } });
  });
});
