import { beforeEach, describe, expect, it } from "vitest";
import { getRotatedModels, handleComboChat, resetComboRotation } from "../../open-sse/services/combo.js";

const log = { info() {}, warn() {} };

describe("combo route affinity", () => {
  beforeEach(resetComboRotation);

  it("tries hard-capable preferred route before a soft-capability winner without rotating the cursor", async () => {
    const models = ["anthropic/claude-sonnet-4-6", "perplexity/sonar"];
    getRotatedModels(models, "combo", "round-robin"); // normal request advances cursor from Anthropic to Perplexity
    const calls = [];
    await handleComboChat({
      body: { messages: [{ role: "user", content: "q" }], tools: [{ type: "web_search" }] },
      models,
      preferredRoute: "anthropic/claude-sonnet-4-6",
      comboName: "combo",
      comboStrategy: "round-robin",
      log,
      handleSingleModel: async (_body, model) => {
        calls.push(model);
        return new Response("ok", { status: 200 });
      },
    });
    await handleComboChat({
      body: { messages: [{ role: "user", content: "q" }] }, models, preferredRoute: "anthropic/claude-sonnet-4-6", comboName: "combo", comboStrategy: "round-robin", log,
      handleSingleModel: async (_body, model) => { calls.push(model); return new Response("ok", { status: 200 }); },
    });
    expect(calls).toEqual(["anthropic/claude-sonnet-4-6", "anthropic/claude-sonnet-4-6"]);
    expect(getRotatedModels(models, "combo", "round-robin")[0]).toBe("perplexity/sonar");
  });

  it("reports rotation only when the combo cursor was used", async () => {
    const selected = [];
    const run = (preferredRoute = null) => handleComboChat({
      body: { messages: [{ role: "user", content: "q" }] }, models: ["a/x", "b/y"], preferredRoute,
      comboName: "combo", comboStrategy: "round-robin", log,
      onSelection: (selection) => selected.push(selection),
      handleSingleModel: async () => new Response("ok", { status: 200 }),
    });
    await run();
    await run("a/x");
    expect(selected).toEqual([{ rotationUsed: true }, { rotationUsed: false }]);
  });
});
