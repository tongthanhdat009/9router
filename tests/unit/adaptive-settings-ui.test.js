import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let dir, db, repo;
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-adaptive-settings-"));
  process.env.DATA_DIR = dir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  repo = await import("@/lib/db/repos/settingsRepo.js");
  await db.initDb();
});
afterAll(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("adaptive settings contracts", () => {
  it("validates layer-specific strategies", () => {
    expect(repo.validateStrategy("combo", "fallback")).toBe(true);
    expect(repo.validateStrategy("provider", "fill-first")).toBe(true);
    expect(repo.validateStrategy("combo", "adaptive-round-robin")).toBe(true);
    expect(repo.validateStrategy("provider", "adaptive-round-robin")).toBe(true);
    expect(repo.validateStrategy("provider", "fusion")).toBe(false);
  });
  it("keeps explicit fallback and fill-first while global strategies rotate", async () => {
    await db.updateSettings({ comboStrategy: "round-robin", fallbackStrategy: "round-robin", comboStrategies: { a: { fallbackStrategy: "fallback", judgeModel: "p/x" } }, providerStrategies: { p: { fallbackStrategy: "fill-first", proxyPoolId: "pool", rotation: { enabled: true } } } });
    const s = await db.getSettings();
    expect(s.comboStrategies.a.fallbackStrategy).toBe("fallback");
    expect(s.providerStrategies.p.fallbackStrategy).toBe("fill-first");
  });
  it("per-layer disable returns each layer to legacy without touching the other", async () => {
    await db.updateSettings({ comboStrategies: { c: { fallbackStrategy: "adaptive-round-robin" } }, providerStrategies: { o: { fallbackStrategy: "adaptive-round-robin" } } });
    await db.updateSettings({ comboStrategies: { c: { fallbackStrategy: "fallback" } } });
    let s = await db.getSettings();
    expect(s.comboStrategies.c.fallbackStrategy).toBe("fallback");
    expect(s.providerStrategies.o.fallbackStrategy).toBe("adaptive-round-robin");
    await db.updateSettings({ providerStrategies: { o: { fallbackStrategy: "fill-first" } } });
    s = await db.getSettings();
    expect(s.comboStrategies.c.fallbackStrategy).toBe("fallback");
    expect(s.providerStrategies.o.fallbackStrategy).toBe("fill-first");
  });
  it("merges nested entries and fields, then deletes only named entries", async () => {
    await db.updateSettings({ comboStrategies: { b: { fallbackStrategy: "adaptive-round-robin" }, a: { fallbackStrategy: "adaptive-round-robin" } }, providerStrategies: { p: { fallbackStrategy: "adaptive-round-robin" }, q: { fallbackStrategy: "round-robin" } } });
    let s = await db.getSettings();
    expect(s.comboStrategies.a.judgeModel).toBe("p/x");
    expect(s.comboStrategies.b.fallbackStrategy).toBe("adaptive-round-robin");
    expect(s.providerStrategies.p.proxyPoolId).toBe("pool");
    expect(s.providerStrategies.p.rotation).toEqual({ enabled: true });
    await db.updateSettings({ comboStrategies: { a: null }, providerStrategies: { p: { fallbackStrategy: "fill-first" } } });
    s = await db.getSettings();
    expect(s.comboStrategies.a).toBeUndefined();
    expect(s.comboStrategies.b.fallbackStrategy).toBe("adaptive-round-robin");
    expect(s.providerStrategies.p.proxyPoolId).toBe("pool");
    expect(s.providerStrategies.q.fallbackStrategy).toBe("round-robin");
  });
});
