import { describe, expect, it } from "vitest";
import { PROVIDER_MODELS } from "../../open-sse/config/providerModels.js";
import { getPricingForModel } from "../../open-sse/providers/pricing.js";

const NON_TOKEN_KINDS = new Set(["image", "stt", "tts", "video", "embedding"]);

export const isTokenPricedModel = (model) =>
  !NON_TOKEN_KINDS.has(model.kind || model.type || "chat") && !/-tts(?:$|[-_:])/i.test(model.id);

// Proprietary virtual/router aliases: neither an owner lab rate nor a same-canonical
// current OpenRouter row is published. Keep this exact, reviewed list small.
export const UNPRICED_TOKEN_MODELS = new Map([
  ["byteplus/seed-2-0-pro-260328", "BytePlus version absent from current OpenRouter catalog"],
  ["siliconflow/inclusionAI/Ling-flash-2.0", "SiliconFlow version absent from current OpenRouter catalog"],
  ["volcengine-ark/Doubao-Seed-2.0-pro", "Volcengine version absent from current OpenRouter catalog"],
  ["hunyuan/hunyuan-turbos-latest", "Tencent proprietary model absent from current OpenRouter catalog"],
  ["hunyuan/hunyuan-t1-latest", "Tencent proprietary model absent from current OpenRouter catalog"],
  ["cu/default", "Cursor server-selected virtual route"],
  ["gh/goldeneye-free-auto", "GitHub Copilot proprietary virtual route"],
  ["if/iflow-rome-30ba3b", "iFlow proprietary model absent from OpenRouter"],
  ["perplexity-web/pplx-auto", "Perplexity Web virtual router"],
  ["perplexity-web/pplx-sonar", "Perplexity Web subscription alias"],
  ["perplexity-web/pplx-gpt", "Perplexity Web subscription alias"],
  ["perplexity-web/pplx-gemini", "Perplexity Web subscription alias"],
  ["perplexity-web/pplx-sonnet", "Perplexity Web subscription alias"],
  ["perplexity-web/pplx-opus", "Perplexity Web subscription alias"],
  ["perplexity-web/pplx-nemotron", "Perplexity Web subscription alias"],
  ["qd/ultimate", "Qoder proprietary virtual route"],
  ["qd/performance", "Qoder proprietary virtual route"],
  ["qd/efficient", "Qoder proprietary virtual route"],
  ["qd/lite", "Qoder proprietary virtual route"],
  ["qd/qmodel_38max", "Qoder proprietary virtual route"],
  ["qd/qmodel_latest", "Qoder proprietary virtual route"],
  ["qd/qmodel", "Qoder proprietary virtual route"],
  ["qd/qfmodel", "Qoder proprietary virtual route"],
  ["qd/kmodel_latest", "Qoder proprietary virtual route"],
  ["qd/kmodel", "Qoder proprietary virtual route"],
  ["qd/gmodel", "Qoder proprietary virtual route"],
  ["qd/gfmodel", "Qoder proprietary virtual route"],
  ["qd/dmodel", "Qoder proprietary virtual route"],
  ["qd/dfmodel", "Qoder proprietary virtual route"],
  ["qd/mmodel", "Qoder proprietary virtual route"],
  ["venice/venice-uncensored-1-2", "Venice proprietary model absent from OpenRouter"],
  ["xiaomi-mimo/mimo-v2-omni", "Xiaomi owner model absent from current OpenRouter catalog"],
  ["xiaomi-mimo/mimo-v2-flash", "Xiaomi owner model absent from current OpenRouter catalog"],
  ["xiaomi-tokenplan/mimo-v2-pro", "Xiaomi owner model absent from current OpenRouter catalog"],
  ["xiaomi-tokenplan/mimo-v2-omni", "Xiaomi owner model absent from current OpenRouter catalog"],
  ["morph/morph-qwen35-397b", "Morph catalog id not returned by the official model endpoint"],
  ["morph/morph-minimax27-230b", "Morph catalog id not returned by the official model endpoint"],
  ["morph/morph-qwen36-27b", "Morph catalog id not returned by the official model endpoint"],
]);

const FREE_PRICING = { input: 0, output: 0, cached: 0, reasoning: 0, cache_creation: 0 };
const EXPECTED_FREE = [
  ["oc", "muse-spark-1.2-contributor-free"],
  ["oc", "muse-spark-1.3-contributor-free"],
  ["oc", "union-alpha"],
  ["mmf", "mimo-auto"],
  ["bzl", "auto:free"],
  ["kgw", "kilo-auto/free"],
  ["kgw", "nvidia/nemotron-3-super-120b-a12b:free"],
  ["kgw", "nvidia/nemotron-3-ultra-550b-a55b:free"],
  ["kgw", "kwaipilot/kat-coder-pro-v2.5:free"],
  ["ollama", "gpt-oss:120b"],
];

const rows = Object.entries(PROVIDER_MODELS)
  .flatMap(([provider, models]) => models.map((model) => ({ provider, model })))
  .filter(({ model }) => isTokenPricedModel(model));

describe("token catalog pricing coverage", () => {
  it("resolves every active token model or documents its deliberate exclusion", () => {
    const missing = rows.filter(({ provider, model }) =>
      !getPricingForModel(provider, model.id) && !UNPRICED_TOKEN_MODELS.has(provider + "/" + model.id)
    );
    expect(missing).toEqual([]);
  });

  it("keeps the deliberate exclusions exact and still unresolved", () => {
    const listed = rows
      .filter(({ provider, model }) => UNPRICED_TOKEN_MODELS.has(provider + "/" + model.id))
      .filter(({ provider, model }) => !getPricingForModel(provider, model.id))
      .map(({ provider, model }) => provider + "/" + model.id)
      .sort();
    expect(listed).toEqual([...UNPRICED_TOKEN_MODELS.keys()].sort());
  });

  it("does not treat non-token catalog kinds as token-priced rows", () => {
    const excluded = Object.values(PROVIDER_MODELS).flat().filter((model) => !isTokenPricedModel(model));
    expect(excluded.length).toBeGreaterThan(0);
    expect(excluded.some((model) => model.kind === "image")).toBe(true);
    expect(excluded.some((model) => model.kind === "tts" || model.type === "tts")).toBe(true);
  });

  it("maps provider-specific owner and OpenRouter prices", () => {
    expect(getPricingForModel("morph", "morph-v3-large")).toMatchObject({ input: 0.9, output: 1.9 });
    expect(getPricingForModel("cloudflare-ai", "@cf/qwen/qwq-32b")).toMatchObject({ input: 0.66, output: 1 });
    expect(getPricingForModel("muse", "muse-spark-1.3")).toMatchObject({ input: 1.25, output: 4.25 });
    expect(getPricingForModel("poolside", "poolside/laguna-s-2.1")).toMatchObject({ input: 0.09, output: 0.18 });
    expect(getPricingForModel("openai", "o3")).toMatchObject({ input: 2, output: 8 });
    expect(getPricingForModel("perplexity", "sonar")).toMatchObject({ input: 1, output: 1 });
  });

  it("keeps confirmed free and local routes at an explicit all-zero price", () => {
    for (const [provider, model] of EXPECTED_FREE) {
      expect(getPricingForModel(provider, model)).toEqual(FREE_PRICING);
    }
  });

  it("pins the requested upstream entries", () => {
    expect(getPricingForModel("openai", "gpt-6-astra")).toMatchObject({ input: 10, output: 50, cached: 1 });
    expect(getPricingForModel("opencode-go", "deepseek-v4.1-flash")).toMatchObject({ input: 0.15, output: 0.6, cached: 0.003 });
    expect(getPricingForModel("deepseek", "deepseek-v4-flash")).toMatchObject({ input: 0.14, output: 0.28 });
  });
});
