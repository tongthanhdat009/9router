import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildCustomCapabilityOverride,
  findExplicitModelCaps,
  getCapabilitiesForModel,
} from "../../open-sse/providers/capabilities.js";
import { stripUnsupportedModalities } from "../../open-sse/translator/concerns/modality.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

// Route + repo are imported dynamically AFTER DATA_DIR points at a temp dir so
// the db adapter graph initializes against an isolated store (same pattern as
// db-concurrent.test.js).
let routeMod;
let aliasRepo;
const originalDataDir = process.env.DATA_DIR;
let tempDir;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-custom-caps-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  routeMod = await import("../../src/app/api/models/custom/route.js");
  aliasRepo = await import("../../src/lib/db/repos/aliasRepo.js");
  const dbIndex = await import("@/lib/db/index.js");
  await dbIndex.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("sanitizeCaps (POST /api/models/custom)", () => {
  it("keeps boolean values on CAPACITY_META keys", () => {
    expect(routeMod.sanitizeCaps({ vision: true, reasoning: false })).toEqual({ vision: true, reasoning: false });
  });

  it("drops junk values and keys outside CAPACITY_META", () => {
    expect(routeMod.sanitizeCaps({ vision: true, pdf: true, search: false, reasoning: "yes" })).toEqual({ vision: true });
    expect(routeMod.sanitizeCaps({ search: false, pdf: true })).toBeNull();
  });

  it("returns null for empty or invalid input", () => {
    expect(routeMod.sanitizeCaps(undefined)).toBeNull();
    expect(routeMod.sanitizeCaps(null)).toBeNull();
    expect(routeMod.sanitizeCaps({})).toBeNull();
    expect(routeMod.sanitizeCaps("junk")).toBeNull();
    expect(routeMod.sanitizeCaps([])).toBeNull();
  });
});

describe("aliasRepo.addCustomModel upsert", () => {
  it("insert persists caps and name", async () => {
    const added = await aliasRepo.addCustomModel({
      providerAlias: "provA", id: "model-a", type: "llm", name: "Model A",
      caps: { vision: true, reasoning: false },
    });
    expect(added).toBe(true);
    const row = (await aliasRepo.getCustomModels()).find((m) => m.providerAlias === "provA" && m.id === "model-a");
    expect(row).toMatchObject({ name: "Model A", type: "llm", caps: { vision: true, reasoning: false } });
  });

  it("partial update merges caps and preserves omitted keys", async () => {
    const added = await aliasRepo.addCustomModel({
      providerAlias: "provA", id: "model-a", type: "llm", name: "Model A2",
      caps: { reasoning: true },
    });
    expect(added).toBe(false);
    const row = (await aliasRepo.getCustomModels()).find((m) => m.providerAlias === "provA" && m.id === "model-a");
    expect(row.name).toBe("Model A2");
    expect(row.caps).toEqual({ vision: true, reasoning: true });
  });

  it("update without caps keeps stored caps", async () => {
    await aliasRepo.addCustomModel({ providerAlias: "provA", id: "model-a", type: "llm", name: "Model A3" });
    const row = (await aliasRepo.getCustomModels()).find((m) => m.providerAlias === "provA" && m.id === "model-a");
    expect(row.name).toBe("Model A3");
    expect(row.caps).toEqual({ vision: true, reasoning: true });
  });

  it("provided caps keys replace previous values", async () => {
    await aliasRepo.addCustomModel({ providerAlias: "provA", id: "model-a", type: "llm", caps: { vision: false } });
    const row = (await aliasRepo.getCustomModels()).find((m) => m.providerAlias === "provA" && m.id === "model-a");
    expect(row.caps).toEqual({ vision: false, reasoning: true });
  });
});

describe("findExplicitModelCaps", () => {
  it("returns null when the registry is silent", () => {
    expect(findExplicitModelCaps("ocg", "zzq-no-such-model-9x")).toBeNull();
    expect(findExplicitModelCaps(null, "zzq-no-such-model-9x")).toBeNull();
  });

  it("returns the raw pattern entry for deepseek-flash (matches *deepseek*)", () => {
    expect(findExplicitModelCaps("ocg", "deepseek-flash")).toEqual({
      reasoning: true, thinkingFormat: "deepseek", contextWindow: 128000,
    });
  });

  it("returns the muse contributor entry with vision+reasoning and no floor keys", () => {
    const raw = findExplicitModelCaps("opencode", "muse-spark-1.3-contributor-free");
    expect(raw.reasoning).toBe(true);
    expect(raw.vision).toBe(true);
    expect("tools" in raw).toBe(false);
  });

  it("declares vision+reasoning for every cataloged muse-spark id on all muse providers", () => {
    for (const provider of ["opencode", "ocg", "muse"]) {
      for (const id of ["muse-spark-1.2", "muse-spark-1.2-contributor", "muse-spark-1.3", "muse-spark-1.3-contributor", "muse-spark-1.2-contributor-free", "muse-spark-1.3-contributor-free"]) {
        const caps = getCapabilitiesForModel(provider, id);
        expect(caps.vision, provider + "/" + id + " vision").toBe(true);
        expect(caps.reasoning, provider + "/" + id + " reasoning").toBe(true);
      }
    }
  });

  it("strips vendor prefixes for the exact-id lookup", () => {
    const raw = findExplicitModelCaps(null, "anthropic/claude-opus-5");
    expect(raw.vision).toBe(true);
    expect(raw.reasoning).toBe(true);
  });

  it("leaves getCapabilitiesForModel floor behavior untouched", () => {
    const floor = getCapabilitiesForModel("ocg", "zzq-no-such-model-9x");
    expect(floor.vision).toBe(false);
    expect(findExplicitModelCaps("ocg", "zzq-no-such-model-9x")).toBeNull();
  });
});

describe("modality strip honors tri-state vision", () => {
  function openAiBody() {
    return {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
        ],
      }],
    };
  }

  it("strips images when vision is explicitly false", () => {
    const body = openAiBody();
    const caps = { vision: false, audioInput: true, pdf: true };
    expect(stripUnsupportedModalities(body, FORMATS.OPENAI, caps)).toBe(true);
    expect(JSON.stringify(body)).not.toContain("image_url");
    expect(JSON.stringify(body)).toContain("[image omitted");
  });

  it("keeps images when vision is unknown (undefined)", () => {
    const body = openAiBody();
    const caps = { vision: undefined, audioInput: undefined, pdf: undefined };
    expect(stripUnsupportedModalities(body, FORMATS.OPENAI, caps)).toBe(false);
    expect(JSON.stringify(body)).toContain("image_url");
  });
});

describe("buildCustomCapabilityOverride tri-state matrix", () => {
  it("returns null when there is no custom row", () => {
    expect(buildCustomCapabilityOverride(null, { vision: true })).toBeNull();
    expect(buildCustomCapabilityOverride(undefined, null)).toBeNull();
  });

  it("stored boolean wins over registry raw (true over raw, false over raw)", () => {
    expect(buildCustomCapabilityOverride({ type: "llm", caps: { vision: true } }, { vision: false }).vision).toBe(true);
    expect(buildCustomCapabilityOverride({ type: "llm", caps: { vision: false } }, { vision: true }).vision).toBe(false);
  });

  it("falls back to raw when stored flag is absent, undefined when registry silent", () => {
    const ov = buildCustomCapabilityOverride({ type: "llm" }, { reasoning: true });
    expect(ov.reasoning).toBe(true);
    expect(ov.vision).toBeUndefined();
    expect("vision" in ov).toBe(true);
  });

  it("plain llm row with NO caps still gets the neutralizing override", () => {
    const ov = buildCustomCapabilityOverride({ type: "llm" }, null);
    for (const k of ["vision", "search", "reasoning", "pdf", "audioInput", "videoInput"]) {
      expect(k in ov).toBe(true);
      expect(ov[k]).toBeUndefined();
    }
  });

  it("an explicit undefined in the override neutralizes the floor key", () => {
    const merged = { ...getCapabilitiesForModel("ocg", "zzq-no-such-model-9x"), ...buildCustomCapabilityOverride({ type: "llm" }, null) };
    expect(merged.vision).toBeUndefined();
    expect(merged.tools).toBe(true);
  });

  it("legacy imageToText rows imply vision unless explicitly pinned false", () => {
    expect(buildCustomCapabilityOverride({ type: "imageToText" }, null).vision).toBe(true);
    expect(buildCustomCapabilityOverride({ type: "imageToText", caps: { vision: false } }, null).vision).toBe(false);
  });
});

describe("sanitizeFormats (POST /api/models/custom)", () => {
  it("keeps known wire formats and dedupes", () => {
    expect(routeMod.sanitizeFormats(["openai", "bogus", "openai", "claude"])).toEqual(["openai", "claude"]);
  });

  it("empty or non-array means no pin", () => {
    expect(routeMod.sanitizeFormats([])).toBeNull();
    expect(routeMod.sanitizeFormats("openai")).toBeNull();
    expect(routeMod.sanitizeFormats(undefined)).toBeNull();
  });

  it("all-unknown input means no pin", () => {
    expect(routeMod.sanitizeFormats(["bogus", "nope"])).toBeNull();
  });
});

describe("custom-model formats storage + resolution", () => {
  it("addCustomModel stores formats on the row", async () => {
    await aliasRepo.addCustomModel({ providerAlias: "ocg", id: "fmt-probe-x", type: "llm", formats: ["openai"] });
    const rows = await aliasRepo.getCustomModels();
    const row = rows.find((m) => m.id === "fmt-probe-x");
    expect(row.formats).toEqual(["openai"]);
  });

  it("re-add without formats preserves stored formats", async () => {
    await aliasRepo.addCustomModel({ providerAlias: "ocg", id: "fmt-probe-x", type: "llm", name: "renamed" });
    const rows = await aliasRepo.getCustomModels();
    const row = rows.find((m) => m.id === "fmt-probe-x");
    expect(row.name).toBe("renamed");
    expect(row.formats).toEqual(["openai"]);
  });

  it("custom formats win over the registry in format resolution", async () => {
    const { getModelSupportedFormats } = await import("../../open-sse/config/providerModels.js");
    // Registry rows are keyed by provider alias, not the short id.
    expect(getModelSupportedFormats("opencode-go", "fmt-probe-x", ["openai"])).toEqual(["openai"]);
    expect(getModelSupportedFormats("opencode-go", "deepseek-v4-flash", ["claude"])).toEqual(["claude"]);
    expect(getModelSupportedFormats("opencode-go", "deepseek-v4-flash")).toEqual(["openai", "claude", "openai-responses"]);
    expect(getModelSupportedFormats("opencode-go", "no-such-model-xyz")).toBeNull();
  });
});
