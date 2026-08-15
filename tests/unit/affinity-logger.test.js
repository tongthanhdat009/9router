import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const getSettings = vi.fn();
vi.mock("../../src/lib/localDb.js", () => ({ getSettings }));

const env = { ...process.env };
const file = path.join(os.tmpdir(), `affinity-${process.pid}.jsonl`);

beforeEach(() => { vi.resetModules(); getSettings.mockReset(); getSettings.mockResolvedValue({ enableObservability: false }); fs.rmSync(file, { force: true }); process.env.AFFINITY_LOG_FILE = file; delete process.env.ENABLE_AFFINITY_LOG; });
afterEach(() => { process.env = { ...env }; fs.rmSync(file, { force: true }); });

describe("affinity logger", () => {
  it("requires observability gate; path override alone does not enable", async () => {
    const { logAffinity } = await import("../../src/lib/affinityLogger.js");
    await logAffinity("affinity.request", { session: "raw" });
    expect(fs.existsSync(file)).toBe(false);
    process.env.ENABLE_AFFINITY_LOG = "1";
    await logAffinity("affinity.request", { requestId: "req-x" });
    expect(JSON.parse(fs.readFileSync(file, "utf8").trim())).toMatchObject({ event: "affinity.request", requestId: "req-x" });
  });

  it("redacts raw secrets and request identifiers", async () => {
    process.env.ENABLE_AFFINITY_LOG = "1";
    const { logAffinity } = await import("../../src/lib/affinityLogger.js");
    await logAffinity("affinity.request", { session: "raw-session", api_key: "key", authorization: "Bearer x", prompt: "hello", prompt_cache_key: "cache", previous_response_id: "resp", thread_id: "zed-thread-raw", safeHash: "sha16", present: true });
    const text = fs.readFileSync(file, "utf8");
    expect(text).not.toContain("raw-session"); expect(text).not.toContain("Bearer x"); expect(text).not.toContain('"cache"'); expect(text).not.toContain("zed-thread-raw"); expect(text).toContain("sha16"); expect(text).toContain('"present":true');
  });

  it("sha16-hashes harness session ids before logging", async () => {
    process.env.ENABLE_AFFINITY_LOG = "1";
    const { logAffinity } = await import("../../src/lib/affinityLogger.js");
    const { sha16 } = await import("../../open-sse/utils/sessionManager.js");
    const sessionHash = sha16("mux-workspace-1");
    await logAffinity("affinity.request", { sessionHash, requestId: "req-h" });
    const text = fs.readFileSync(file, "utf8");
    expect(text).not.toContain("mux-workspace-1");
    expect(text).toContain(sessionHash);
  });
});
