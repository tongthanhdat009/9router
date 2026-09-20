import { describe, expect, it } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { PROVIDER_MODELS, getModelTargetFormat } from "../../open-sse/config/providerModels.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";
import { OpenCodeGoExecutor } from "../../open-sse/executors/opencode-go.js";
import { MuseExecutor } from "../../open-sse/executors/muse.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import "../translator/registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";

const MODEL = "muse-spark-1.2-contributor-free";
const PROVIDER = "opencode";

const input = [{
  type: "message",
  role: "user",
  content: [{ type: "input_text", text: "Think, then answer: 2 + 2?" }],
}];

describe("OpenCode Free Muse Spark thinking", () => {
  it("advertises reasoning and the requested model limits", () => {
    expect(PROVIDER_MODELS.oc?.some((model) => model.id === MODEL)).toBe(true);
    expect(PROVIDER_MODELS.oc?.some((model) => model.id === "muse-spark-1.3-contributor-free")).toBe(true);
    for (const m of [MODEL, "muse-spark-1.3-contributor-free", "muse-spark-1.4-contributor-free", "muse-spark-2.0-contributor-free"]) {
      expect(getCapabilitiesForModel(PROVIDER, m)).toMatchObject({
        reasoning: true,
        thinkingFormat: "openai",
        contextWindow: 1048576,
        maxOutput: 131072,
      });
      expect(getCapabilitiesForModel(PROVIDER, `oc/${m}`)).toMatchObject({
        reasoning: true,
        contextWindow: 1048576,
        maxOutput: 131072,
      });
      expect(getThinkingLevels(PROVIDER, m)).toEqual([
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
      ]);
      expect(getModelTargetFormat("oc", m)).toBe(FORMATS.OPENAI_RESPONSES);
      expect(getModelTargetFormat("opencode", m)).toBe(FORMATS.OPENAI_RESPONSES);
      expect(getModelTargetFormat("openrouter", m)).toBeNull();
    }
  });

  it("clamps max to xhigh and emits the Responses reasoning shape", () => {
    const body = {
      input,
      reasoning: { effort: "max" },
      max_tokens: 131072,
    };

    const out = new OpenCodeExecutor().transformRequest(MODEL, body, true, {
      connectionId: "opencode-muse-spark-test",
    });

    expect(out.reasoning).toEqual({ effort: "xhigh", summary: "auto" });
    expect(out.reasoning_effort).toBeUndefined();
    expect(out.max_output_tokens).toBe(131072);
    expect(out.max_tokens).toBeUndefined();
  });

  it("routes Union Alpha through Messages with declared capabilities", () => {
    const executor = new OpenCodeExecutor();
    expect(getCapabilitiesForModel(PROVIDER, "union-alpha")).toMatchObject({
      vision: true, contextWindow: 262144, maxOutput: 131072,
    });
    expect(getModelTargetFormat("oc", "union-alpha")).toBe(FORMATS.CLAUDE);
    const url = executor.buildUrl("union-alpha");
    expect(url).toBe("https://opencode.ai/zen/v1/messages");
    expect(executor.buildHeaders({}, true, url)).toMatchObject({ "anthropic-version": "2023-06-01" });
  });

  it("forces the upstream stream and preserves caller tools while adding decoys", () => {
    const executor = new OpenCodeExecutor();
    const chat = executor.transformRequest("big-pickle", {
      stream: false,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "Bash", description: "caller" } }],
    });
    expect(chat.stream).toBe(true);
    expect(chat.tools.map((tool) => tool.function.name)).toEqual(["Bash", "bash", "read"]);

    const responses = executor.transformRequest("muse-spark-1.3-contributor-free", {
      stream: false,
      input: structuredClone(input),
      tools: [{ type: "function", name: "weather", parameters: { type: "object", properties: {} } }],
      tool_choice: "required",
    });
    expect(responses.stream).toBe(true);
    expect(responses.tool_choice).toBe("auto");
    expect(responses.tools.map((tool) => tool.name)).toEqual(["weather", "bash", "read"]);
  });

  it("sanitizes prior Responses reasoning without losing function turns", () => {
    const body = {
      input: [
        ...structuredClone(input),
        { type: "reasoning", encrypted_content: "not-valid-here" },
        { type: "function_call", call_id: "call_1", name: "shell", arguments: { command: "echo hi" } },
        { type: "function_call_output", call_id: "call_1", output: { ok: true } },
      ],
    };
    const out = new OpenCodeExecutor().transformRequest("muse-spark-1.3-contributor-free", body, true, {});
    expect(out.input.map((item) => item.type)).toEqual(["message", "function_call", "function_call_output"]);
    expect(out.input[1].arguments).toBe('{"command":"echo hi"}');
    expect(out.input[2].output).toBe('{"ok":true}');
  });

  it("leaves the other free models on Chat Completions", () => {
    const executor = new OpenCodeExecutor();
    const body = { messages: [{ role: "user", content: "hi" }], max_tokens: 1024 };
    executor.transformRequest("big-pickle", body, true, {});
    expect(executor.buildUrl("big-pickle")).toBe("https://opencode.ai/zen/v1/chat/completions");
    expect(body.max_tokens).toBe(1024);
    expect(body.max_output_tokens).toBeUndefined();
  });

  it("translates Chat Completions max thinking into a Responses request", () => {
    const body = {
      model: `oc/${MODEL}`,
      messages: [{ role: "user", content: "Think, then answer: 2 + 2?" }],
      reasoning_effort: "max",
      max_tokens: 131072,
    };

    const translated = translateRequest(
      FORMATS.OPENAI,
      FORMATS.OPENAI_RESPONSES,
      MODEL,
      body,
      true,
      {},
      PROVIDER,
    );
    const out = new OpenCodeExecutor().transformRequest(MODEL, translated, true, {
      connectionId: "opencode-muse-spark-translation-test",
    });

    expect(out.reasoning).toEqual({ effort: "xhigh", summary: "auto" });
    expect(out.max_output_tokens).toBe(131072);
    expect(out.max_tokens).toBeUndefined();
  });

  it("routes muse-spark-1.3-contributor-free and future Muse Spark models to Responses API", () => {
    const executor = new OpenCodeExecutor();
    const futureModel = "muse-spark-1.4-contributor-free";

    for (const m of ["muse-spark-1.3-contributor-free", futureModel]) {
      expect(executor.buildUrl(m)).toBe("https://opencode.ai/zen/v1/responses");
      expect(executor.buildUrl(`${m}(high)`)).toBe("https://opencode.ai/zen/v1/responses");
      expect(getModelTargetFormat("oc", m)).toBe("openai-responses");

      const body = {
        model: `oc/${m}`,
        messages: [{ role: "user", content: "Hello" }],
        reasoning_effort: "high",
        max_tokens: 2048,
      };

      const translated = translateRequest(
        FORMATS.OPENAI,
        FORMATS.OPENAI_RESPONSES,
        m,
        body,
        true,
        {},
        PROVIDER,
      );
      const out = executor.transformRequest(m, translated, true, {
        connectionId: "opencode-muse-spark-13-test",
      });

      expect(out.reasoning).toEqual({ effort: "high", summary: "auto" });
      expect(out.max_output_tokens).toBe(2048);
      expect(out.max_tokens).toBeUndefined();
    }
  });

  it("applies Responses-format reasoning object and omits reasoning_effort for openai-responses wire", () => {
    const body = {
      input,
      reasoning_effort: "high",
    };

    const out = applyThinking(
      FORMATS.OPENAI_RESPONSES,
      "muse-spark-1.3-contributor",
      body,
      "muse",
    );

    expect(out.reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(out.reasoning_effort).toBeUndefined();
  });

  it.each([
    [OpenCodeGoExecutor, "muse-spark-1.3-contributor"],
    [MuseExecutor, "muse-spark-1.3-contributor"],
  ])("preserves reasoning and strips reasoning_effort in executor transformRequest (%s)", (Executor, model) => {
    const body = {
      input,
      reasoning: { effort: "high", summary: "auto" },
      reasoning_effort: "high",
      max_output_tokens: 2048,
    };

    const out = new Executor().transformRequest(
      model,
      body,
      true,
      {},
    );

    expect(out.reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(out.reasoning_effort).toBeUndefined();
    expect(out.max_output_tokens).toBe(2048);
  });

  it.each([
    [OpenCodeExecutor, "muse-spark-1.3-contributor-free"],
    [OpenCodeGoExecutor, "muse-spark-1.3-contributor"],
  ])("removes RE2-incompatible JSON Schema patterns before Console validation (%s)", (Executor, model) => {
    const body = {
      input,
      tools: [{
        type: "function",
        name: "find",
        parameters: {
          type: "object",
          properties: {
            bad: { type: "string", pattern: "^(?!__.*__$)[a-z]{1,200}$" },
            good: { type: "string", pattern: "^[a-z]+$" },
          },
        },
      }],
    };

    const out = new Executor().transformRequest(model, body, true, {});

    expect(out.tools[0].parameters.properties.bad.pattern).toBeUndefined();
    expect(out.tools[0].parameters.properties.good.pattern).toBe("^[a-z]+$");
  });
});
