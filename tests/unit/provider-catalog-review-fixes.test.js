/**
 * Regression guards for the review catalog fixes:
 *   1. CodeBuddy CN completes the upstream 807553e2 v4.1 swap — the
 *      superseded deepseek-v4-flash row must be gone from both the
 *      registry and the per-provider capability map (which kept a stale
 *      50k maxOutput), while deepseek-v4.1-flash stays at 128000.
 *   2. Task 12's OpenAI image mirror includes gpt-image-2 and
 *      gpt-image-1.5 alongside the 2.5 variants from the Codex catalog.
 */
import { describe, it, expect } from "vitest";

import { getModelsByProviderId } from "../../open-sse/config/providerModels.js";
import { PROVIDER_CAPABILITIES } from "../../open-sse/providers/capabilities.js";

describe("CodeBuddy CN deepseek-v4.1 swap", () => {
  it("no longer lists the superseded deepseek-v4-flash", () => {
    expect(getModelsByProviderId("codebuddy-cn").some((m) => m.id === "deepseek-v4-flash")).toBe(false);
  });

  it("lists deepseek-v4.1-flash with the 128000 output ceiling", () => {
    const row = getModelsByProviderId("codebuddy-cn").find((m) => m.id === "deepseek-v4.1-flash");
    expect(row).toBeDefined();
    expect(PROVIDER_CAPABILITIES["codebuddy-cn"]["deepseek-v4.1-flash"].maxOutput).toBe(128000);
  });

  it("drops the stale per-provider capability row for deepseek-v4-flash", () => {
    expect(PROVIDER_CAPABILITIES["codebuddy-cn"]["deepseek-v4-flash"]).toBeUndefined();
  });
});

describe("OpenAI mirrored Codex image ids", () => {
  it.each(["gpt-image-2.5", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "gpt-image-2", "gpt-image-1.5"])(
    "mirrors %s as an image model",
    (id) => {
      const row = getModelsByProviderId("openai").find((m) => m.id === id);
      expect(row).toBeDefined();
      expect(row.kind).toBe("image");
      expect(row.params).toEqual(["n", "size", "quality", "response_format"]);
    },
  );
});
