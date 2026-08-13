import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const files = [];

afterEach(() => {
  for (const file of files.splice(0)) fs.rmSync(file, { force: true });
  delete process.env.OAUTH_REFRESH_MONITOR_FILE;
});

describe("oauth refresh monitor", () => {
  it("appends JSONL and redacts sensitive fields", async () => {
    const file = path.join(os.tmpdir(), `oauth-monitor-${process.pid}-${Date.now()}.jsonl`);
    files.push(file);
    process.env.OAUTH_REFRESH_MONITOR_FILE = file;
    const { monitorOAuthRefresh } = await import("../../src/lib/oauthRefreshMonitor.js");

    monitorOAuthRefresh("TEST", { accessToken: "secret", email: "person@example.com", connectionId: "connection-1" });

    const record = JSON.parse(fs.readFileSync(file, "utf8").trim().split("\n").at(-1));
    expect(record).toMatchObject({ event: "TEST", connectionId: "connection-1", accessToken: "[redacted]", email: "[redacted]" });
    expect(record.pid).toBe(process.pid);
  });
});
