import { describe, it, expect } from "vitest";
import { mergeUsage, normalizeUsage } from "../../open-sse/utils/usageTracking.js";

describe("adaptive authoritative usage after estimated finish", () => {
  it("replaces estimated counts with terminal provider usage", () => {
    const estimated = { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100, estimated: true };
    const real = normalizeUsage({ prompt_tokens: 8, completion_tokens: 64, total_tokens: 72 });
    expect(mergeUsage(estimated, real)).toEqual(real);
  });
  it("keeps estimated marker if no authoritative usage arrives", () => {
    const estimated = { prompt_tokens: 8, completion_tokens: 64, estimated: true };
    expect(mergeUsage(estimated, { completion_tokens: 0 }).estimated).toBe(true);
  });
});
