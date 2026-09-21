import { describe, expect, it } from "vitest";

import { mergeProviderModels } from "../../src/shared/utils/providerModelsFetcher.js";

describe("mergeProviderModels", () => {
  it("keeps the first model when later groups contain the same value", () => {
    const custom = [{ id: "model-a", name: "Custom A", value: "kc/model-a" }];
    const suggested = [
      { id: "model-a", name: "Suggested A", value: "kc/model-a" },
      { id: "model-b", name: "Suggested B", value: "kc/model-b" },
    ];
    const fallback = [{ id: "model-b", name: "Fallback B", value: "kc/model-b" }];

    expect(mergeProviderModels(custom, suggested, fallback)).toEqual([
      custom[0],
      suggested[1],
    ]);
  });

  it("ignores invalid entries without a value", () => {
    expect(mergeProviderModels([null, { id: "missing" }], [{ id: "ok", value: "kc/ok" }]))
      .toEqual([{ id: "ok", value: "kc/ok" }]);
  });
});
