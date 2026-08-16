import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const files = [];

afterEach(() => {
  for (const file of files.splice(0)) fs.rmSync(file, { force: true, recursive: true });
  delete process.env.ENABLE_CODEX_TRANSPORT_LOG;
  delete process.env.CODEX_TRANSPORT_LOG_FILE;
});

function readJsonl(file) {
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

describe("codex transport monitor", () => {
  it("is disabled by default and writes no file", async () => {
    const file = path.join(os.tmpdir(), `codex-transport-off-${process.pid}-${Date.now()}.jsonl`);
    files.push(file);
    delete process.env.ENABLE_CODEX_TRANSPORT_LOG;
    process.env.CODEX_TRANSPORT_LOG_FILE = file;
    const { monitorCodexTransport } = await import("../../src/lib/codexTransportMonitor.js");

    expect(monitorCodexTransport("CODEX_WS_ATTEMPT", { transport: "websocket" })).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("appends valid newline-delimited JSON with expected events and safe primitives", async () => {
    const file = path.join(os.tmpdir(), `codex-transport-on-${process.pid}-${Date.now()}.jsonl`);
    files.push(file);
    process.env.ENABLE_CODEX_TRANSPORT_LOG = "1";
    process.env.CODEX_TRANSPORT_LOG_FILE = file;
    const { monitorCodexTransport } = await import("../../src/lib/codexTransportMonitor.js");

    expect(monitorCodexTransport("CODEX_WS_ATTEMPT", { transport: "websocket", attempt: 0 })).toBe(true);
    expect(monitorCodexTransport("CODEX_WS_CONNECTED", { transport: "websocket", framesEmitted: 1 })).toBe(true);
    expect(monitorCodexTransport("CODEX_WS_FALLBACK_HTTP", { transport: "http-sse", reason: "WebSocket first frame timeout (250ms)", errorName: "WsStreamError", framesEmitted: 0, attempt: 0 })).toBe(true);
    expect(monitorCodexTransport("CODEX_HTTP_SSE_SELECTED", { transport: "http-sse" })).toBe(true);

    const records = readJsonl(file);
    expect(records.map((r) => r.event)).toEqual([
      "CODEX_WS_ATTEMPT",
      "CODEX_WS_CONNECTED",
      "CODEX_WS_FALLBACK_HTTP",
      "CODEX_HTTP_SSE_SELECTED",
    ]);
    for (const record of records) {
      expect(typeof record.timestamp).toBe("string");
      expect(record.pid).toBe(process.pid);
    }
    expect(records[0]).toMatchObject({ transport: "websocket", attempt: 0 });
    expect(records[2]).toMatchObject({ errorName: "WsStreamError", framesEmitted: 0, transport: "http-sse" });
  });

  it("redacts sensitive nested detail", async () => {
    const file = path.join(os.tmpdir(), `codex-transport-redact-${process.pid}-${Date.now()}.jsonl`);
    files.push(file);
    process.env.ENABLE_CODEX_TRANSPORT_LOG = "1";
    process.env.CODEX_TRANSPORT_LOG_FILE = file;
    const { monitorCodexTransport } = await import("../../src/lib/codexTransportMonitor.js");

    monitorCodexTransport("CODEX_WS_FALLBACK_HTTP", {
      transport: "http-sse",
      detail: {
        accessToken: "secret-token",
        authorization: "Bearer abc",
        nested: { model: "gpt-5", input: "user prompt", sessionId: "s-1", account_id: "acc-1" },
      },
    });

    const record = readJsonl(file).at(-1);
    expect(JSON.stringify(record)).not.toContain("secret-token");
    expect(JSON.stringify(record)).not.toContain("Bearer abc");
    expect(JSON.stringify(record)).not.toContain("gpt-5");
    expect(JSON.stringify(record)).not.toContain("user prompt");
    expect(JSON.stringify(record)).not.toContain("s-1");
    expect(JSON.stringify(record)).not.toContain("acc-1");
    expect(record).not.toHaveProperty("detail");
  });

  it("never throws into request path", async () => {
    // Parent path is an existing regular file → mkdirSync throws ENOTDIR instantly.
    // (/proc dead paths hang mkdirSync on Linux procfs, never reaching the catch.)
    const blocker = path.join(os.tmpdir(), `codex-transport-blocker-${process.pid}-${Date.now()}`);
    fs.writeFileSync(blocker, "x");
    files.push(blocker);
    process.env.ENABLE_CODEX_TRANSPORT_LOG = "1";
    process.env.CODEX_TRANSPORT_LOG_FILE = path.join(blocker, "codex-transport.jsonl");
    const { monitorCodexTransport } = await import("../../src/lib/codexTransportMonitor.js");

    expect(() => monitorCodexTransport("CODEX_HTTP_SSE_SELECTED", { transport: "http-sse" })).not.toThrow();
    expect(monitorCodexTransport("CODEX_HTTP_SSE_SELECTED", { transport: "http-sse" })).toBe(false);
  });
});
