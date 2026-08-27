import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { chatCompletionToResponses } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");
const { openAICompletionToResponses } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");

function baseBody(usageOverrides = {}) {
  return {
    id: "chatcmpl-test123",
    object: "chat.completion",
    created: 1700000000,
    model: "test-model",
    choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, ...usageOverrides },
  };
}

function runMatrix(converter, label) {
  describe(label, () => {
    it("maps prompt_tokens_details.cached_tokens", () => {
      const out = converter(baseBody({ prompt_tokens_details: { cached_tokens: 42 } }));
      expect(out.usage.input_tokens_details).toEqual({ cached_tokens: 42 });
    });
    it("falls back to cache_read_input_tokens", () => {
      const out = converter(baseBody({ cache_read_input_tokens: 33 }));
      expect(out.usage.input_tokens_details).toEqual({ cached_tokens: 33 });
    });
    it("falls back to prompt_cache_hit_tokens", () => {
      const out = converter(baseBody({ prompt_cache_hit_tokens: 21 }));
      expect(out.usage.input_tokens_details).toEqual({ cached_tokens: 21 });
    });
    it("falls back to cached_tokens", () => {
      const out = converter(baseBody({ cached_tokens: 11 }));
      expect(out.usage.input_tokens_details).toEqual({ cached_tokens: 11 });
    });
    it("obeys precedence: prompt_tokens_details wins over all fallbacks", () => {
      const out = converter(baseBody({
        prompt_tokens_details: { cached_tokens: 5 },
        cache_read_input_tokens: 6,
        prompt_cache_hit_tokens: 7,
        cached_tokens: 8,
      }));
      expect(out.usage.input_tokens_details).toEqual({ cached_tokens: 5 });
    });
    it("obeys precedence: cache_read wins over prompt_cache_hit and cached_tokens", () => {
      const out = converter(baseBody({
        cache_read_input_tokens: 6,
        prompt_cache_hit_tokens: 7,
        cached_tokens: 8,
      }));
      expect(out.usage.input_tokens_details).toEqual({ cached_tokens: 6 });
    });
    it("obeys precedence: prompt_cache_hit wins over cached_tokens", () => {
      const out = converter(baseBody({ prompt_cache_hit_tokens: 7, cached_tokens: 8 }));
      expect(out.usage.input_tokens_details).toEqual({ cached_tokens: 7 });
    });
    it("preserves zero (does not fall through)", () => {
      const out = converter(baseBody({ prompt_tokens_details: { cached_tokens: 0 }, cache_read_input_tokens: 99 }));
      expect(out.usage.input_tokens_details).toEqual({ cached_tokens: 0 });
    });
    it("omits input_tokens_details when absent", () => {
      const out = converter(baseBody({}));
      expect(out.usage.input_tokens_details).toBeUndefined();
      expect(out.usage).not.toHaveProperty("input_tokens_details");
    });
    it("omits input_tokens_details when all sources null/undefined", () => {
      const out = converter(baseBody({ prompt_tokens_details: { cached_tokens: null }, cache_read_input_tokens: null }));
      expect(out.usage.input_tokens_details).toBeUndefined();
    });
    it("preserves totals and non-cache shape", () => {
      const body = baseBody({ prompt_tokens_details: { cached_tokens: 9 } });
      const out = converter(body);
      expect(out.usage.input_tokens).toBe(100);
      expect(out.usage.output_tokens).toBe(20);
      expect(out.usage.total_tokens).toBe(120);
      expect(out.object).toBe("response");
      expect(out.model).toBe("test-model");
      expect(out.output.length).toBeGreaterThan(0);
    });
    it("does not emit cache-creation field", () => {
      const out = converter(baseBody({ prompt_tokens_details: { cached_tokens: 4 }, cache_creation_input_tokens: 50 }));
      expect(out.usage.input_tokens_details).toEqual({ cached_tokens: 4 });
      expect(JSON.stringify(out.usage)).not.toContain("cache_creation");
    });
  });
}

runMatrix(chatCompletionToResponses, "chatCompletionToResponses (sseToJsonHandler)");
runMatrix(openAICompletionToResponses, "openAICompletionToResponses (nonStreamingHandler)");
