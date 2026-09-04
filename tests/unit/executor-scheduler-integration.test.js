import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { BaseExecutor } from "../../open-sse/executors/base.js";
import * as scheduler from "../../open-sse/scheduling/trafficScheduler.js";
import * as proxyFetch from "../../open-sse/utils/proxyFetch.js";

describe("BaseExecutor trafficScheduler integration", () => {
  let executor;

  beforeEach(() => {
    scheduler.resetSchedulerForTests();
    executor = new BaseExecutor("openrouter", {
      baseUrl: "https://example.com",
      baseUrls: ["https://example.com"],
      retry: { maxAttempts: 1 }
    });
    executor.buildUrl = () => "https://example.com/v1/chat/completions";
    executor.buildHeaders = () => ({ "content-type": "application/json" });
    executor.transformRequest = (_m, b) => b;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls beforeUpload before proxyAwareFetch with exact serialized byte count", async () => {
    const beforeUploadSpy = vi.spyOn(scheduler, "beforeUpload");
    const fakeResponse = { status: 200, headers: new Map(), body: { getReader() { return { read() { return Promise.resolve({ done: true }); } }; } } };
    vi.spyOn(proxyFetch, "proxyAwareFetch").mockResolvedValue(fakeResponse);

    const body = { model: "m", messages: [{ role: "user", content: "hello" }] };
    const expectedBytes = Buffer.byteLength(JSON.stringify(body), "utf8");

    await executor.execute({
      model: "m",
      body,
      stream: false,
      credentials: { apiKey: "k" },
      log: { debug() {} }
    });

    expect(beforeUploadSpy).toHaveBeenCalledTimes(1);
    expect(beforeUploadSpy).toHaveBeenCalledWith(
      expect.objectContaining({ actualBytes: expectedBytes })
    );
  });

  it("calls beforePrepare during prepareRequestFair", async () => {
    const beforePrepareSpy = vi.spyOn(scheduler, "beforePrepare");
    const body = { model: "m", messages: [{ role: "user", content: "hello" }] };

    await executor.prepareRequestFair({
      model: "m",
      body,
      stream: false,
      credentials: { apiKey: "k" }
    });

    expect(beforePrepareSpy).toHaveBeenCalledTimes(1);
    expect(beforePrepareSpy).toHaveBeenCalledWith(
      expect.objectContaining({ estimatedSize: 5 })
    );
  });
});
