import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));

const { FreebuffExecutor } = await import("../../open-sse/executors/freebuff.js");
const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

const AGENT_RUNS = "https://www.codebuff.com/api/v1/agent-runs";
const CHAT_URL = "https://www.codebuff.com/api/v1/chat/completions";
const ok = (payload) => new Response(JSON.stringify(payload), { status: 200 });

function baseCreds(overrides = {}) {
  return {
    connectionId: "conn-1",
    accessToken: "login-token",
    providerSpecificData: { userId: "u-1", fingerprintId: "fp-1", ...overrides },
  };
}

function startOk() { return { ok: true, status: 200, statusText: "OK", text: () => Promise.resolve(JSON.stringify({ runId: "run-7" })) }; }
function startBad(status, payload) {
  return { ok: false, status, statusText: "Bad", text: () => Promise.resolve(typeof payload === "string" ? payload : JSON.stringify(payload)) };
}

async function run(executor, { signal, preparedRequest, creds = baseCreds(), proxyOptions = null } = {}) {
  return executor.execute({ model: "z-ai/glm-5.3-flash", body: { model: "z-ai/glm-5.3-flash", messages: [{ role: "user", content: "hi" }] }, stream: false, credentials: creds, signal, log: console, preparedRequest, proxyOptions });
}

describe("freebuff executor lifecycle", () => {
  beforeEach(() => {
    vi.mocked(proxyAwareFetch).mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends official START before chat and returns its runId in the chat body", async () => {
    const executor = new FreebuffExecutor();
    const calls = [];
    vi.mocked(proxyAwareFetch).mockImplementation(async (url, options) => {
      calls.push([String(url), options]);
      if (url === AGENT_RUNS && JSON.parse(options.body).status === "START") return startOk();
      throw new Error("unexpected fetch " + url);
    });
    const superExecute = vi.spyOn(Object.getPrototypeOf(FreebuffExecutor.prototype), "execute").mockImplementation(async (args) => {
      const body = executor.transformRequest(args.model, args.body, args.stream, args.credentials);
      return { response: ok({ done: true }), transformedBody: body };
    });
    const result = await run(executor);
    expect(result.transformedBody.codebuff_metadata.run_id).toBe("run-7");
    superExecute.mockRestore();
    expect(calls[0][0]).toBe(AGENT_RUNS);
    const startBody = JSON.parse(calls[0][1].body);
    expect(startBody).toMatchObject({ status: "START", agentId: "9router", userId: "u-1" });
    expect(calls[0][1].headers.Authorization).toBe("Bearer login-token");
    expect(calls.length).toBe(2); // START + FINISH only; chat went through the super spy
    const finishBody = JSON.parse(calls[1][0] === AGENT_RUNS ? calls[1][1].body : "{}");
    expect(finishBody).toMatchObject({ status: "FINISH", runId: "run-7", totalSteps: 1, directCredits: 0, totalCredits: 0, errorMessage: null });
    expect(finishBody.steps).toEqual([]);
  });

  it("nested snake_case codebuff_metadata wins over client extras and raw leftovers", async () => {
    const executor = new FreebuffExecutor();
    vi.mocked(proxyAwareFetch).mockImplementation(async () => startOk());
    const superExecute = vi.spyOn(Object.getPrototypeOf(FreebuffExecutor.prototype), "execute").mockImplementation(async (args) => {
      const body = executor.transformRequest(args.model, args.body, args.stream, args.credentials);
      return { response: ok({}), transformedBody: body };
    });
    await run(executor, {
      superImpl: undefined,
      creds: baseCreds({ clientSessionId: "psd-client" }),
    });
    superExecute.mockRestore();
    const creds = baseCreds({ clientSessionId: "psd-client" });
    creds.__freebuffRunId = "run-7";
    const injected = executor.transformRequest("m", {
      runId: "client-run",
      clientId: "client-client",
      extraCodebuffMetadata: { run_id: "sneaky" },
      codebuff_metadata: { run_id: "sneaky2", client_id: "sneaky3", trace_session_id: "trace-1" },
    }, false, creds);
    expect(injected.runId).toBeUndefined();
    expect(injected.clientId).toBeUndefined();
    expect(injected.extraCodebuffMetadata).toBeUndefined();
    expect(injected.codebuff_metadata.run_id).toBe("run-7");
    expect(injected.codebuff_metadata.client_id).toBe("psd-client");
    expect(injected.codebuff_metadata.trace_session_id).toBe("trace-1");
    expect(injected.codebuff_metadata.cost_mode).toBe("normal");
    expect(injected.provider).toEqual({ order: undefined, allow_fallbacks: false });
  });

  it("buildHeaders carries Bearer login token and acting-user header only when known", async () => {
    const executor = new FreebuffExecutor();
    const withUser = executor.buildHeaders(baseCreds(), false);
    expect(withUser.Authorization).toBe("Bearer login-token");
    expect(withUser["x-freebuff-acting-user-id"]).toBe("u-1");
    const noUser = executor.buildHeaders({ accessToken: "login-token", providerSpecificData: {} }, false);
    expect(noUser["x-freebuff-acting-user-id"]).toBeUndefined();
  });

  it("START failure surfaces upstream status without any chat request", async () => {
    const executor = new FreebuffExecutor();
    const calls = [];
    vi.mocked(proxyAwareFetch).mockImplementation(async (url, options) => {
      calls.push(String(url));
      return startBad(400, { message: "No runId found in request body" });
    });
    const superExecute = vi.spyOn(Object.getPrototypeOf(FreebuffExecutor.prototype), "execute");
    await expect(run(executor)).rejects.toThrow(/FreeBuff START failed: 400/);
    expect(calls).toEqual([AGENT_RUNS]);
    expect(superExecute).not.toHaveBeenCalled();
    superExecute.mockRestore();
  });

  it("FINISH fires on chat failure with errorMessage and never throws", async () => {
    const executor = new FreebuffExecutor();
    const calls = [];
    vi.mocked(proxyAwareFetch).mockImplementation(async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      if (JSON.parse(options.body).status === "START") return startOk();
      throw new Error("finish transport boom");
    });
    const superExecute = vi.spyOn(Object.getPrototypeOf(FreebuffExecutor.prototype), "execute").mockRejectedValue(new Error("upstream 500"));
    await expect(run(executor)).rejects.toThrow("upstream 500");
    superExecute.mockRestore();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const finish = calls.find((call) => call.body.status === "FINISH");
    expect(finish.body.runId).toBe("run-7");
    expect(finish.body.errorMessage).toContain("upstream 500");
    expect(finish.body.directCredits).toBe(0);
  });

  it("FINISH rejection stays silent even when unhandled", async () => {
    const executor = new FreebuffExecutor();
    vi.mocked(proxyAwareFetch).mockImplementation(async (url, options) => {
      if (JSON.parse(options.body).status === "START") return startOk();
      return Promise.reject(new Error("finish exploded"));
    });
    const superExecute = vi.spyOn(Object.getPrototypeOf(FreebuffExecutor.prototype), "execute").mockResolvedValue({ response: ok({}) });
    await expect(run(executor)).resolves.toBeTruthy();
    superExecute.mockRestore();
  });

  it("cancellation signal and proxyOptions propagate into START, chat, and FINISH fetches", async () => {
    const executor = new FreebuffExecutor();
    const controller = new AbortController();
    const seen = [];
    const proxyOptions = { socksProxyUrl: "socks5://127.0.0.1:1080" };
    vi.mocked(proxyAwareFetch).mockImplementation(async (url, options, po) => {
      seen.push([String(url), options.signal, po]);
      if (JSON.parse(options.body).status === "START") return startOk();
      return ok({});
    });
    const superExecute = vi.spyOn(Object.getPrototypeOf(FreebuffExecutor.prototype), "execute").mockImplementation(async (args) => {
      seen.push(["super.chat", args.signal, args.proxyOptions]);
      return { response: ok({}) };
    });
    await run(executor, { signal: controller.signal, proxyOptions });
    superExecute.mockRestore();
    for (const [url, sig, po] of seen) {
      expect(sig).toBe(controller.signal);
      expect(po).toBe(proxyOptions);
    }
    expect(seen.length).toBe(3);
  });

  it("chat fetch through the real BaseExecutor posts the transformed body to the chat URL", async () => {
    const executor = new FreebuffExecutor();
    const calls = [];
    const controller = new AbortController();
    vi.mocked(proxyAwareFetch).mockImplementation(async (url, options) => {
      calls.push([String(url), options]);
      if (JSON.parse(options.body).status === "START") return startOk();
      return ok({ choices: [{ message: { role: "assistant", content: "hey" } }] });
    });
    await run(executor, { signal: controller.signal });
    expect(calls.length).toBe(3); // START + chat + fire-and-forget FINISH
    const [chatUrl, chatOptions] = calls[1];
    expect(chatUrl).toBe(CHAT_URL);
    const chatBody = JSON.parse(chatOptions.body);
    expect(chatBody.codebuff_metadata.run_id).toBe("run-7");
    expect(chatBody.provider.allow_fallbacks).toBe(false);
    expect(chatOptions.headers.Authorization).toBe("Bearer login-token");
    expect(chatOptions.headers["x-freebuff-acting-user-id"]).toBe("u-1");
    expect(chatOptions.signal).toBeTruthy();
    expect(chatOptions.signal.aborted).toBe(false);
    controller.abort();
    expect(chatOptions.signal.aborted).toBe(true);
  });

  it("cost_mode free only when stored session explicitly says free; stale preparedRequest is ignored", async () => {
    const executor = new FreebuffExecutor();
    vi.mocked(proxyAwareFetch).mockImplementation(async () => startOk());
    const superExecute = vi.spyOn(Object.getPrototypeOf(FreebuffExecutor.prototype), "execute").mockImplementation(async (args) => {
      expect(args.preparedRequest).toBeNull();
      const body = executor.transformRequest(args.model, args.body, args.stream, args.credentials);
      return { response: ok({}), transformedBody: body };
    });
    const result = await run(executor, { preparedRequest: { transformedBody: {}, ctx: {}, bodyStr: "stale" }, creds: baseCreds({ costMode: "free" }) });
    expect(result.transformedBody.codebuff_metadata.cost_mode).toBe("free");
    superExecute.mockRestore();
  });
});

describe("freebuff executor identity", () => {
  it("stable client_id falls back per connection and PSD wins", () => {
    const executor = new FreebuffExecutor();
    const creds = { connectionId: "conn-9", providerSpecificData: {} };
    const first = executor.transformRequest("m", {}, false, creds).codebuff_metadata.client_id;
    const second = executor.transformRequest("m", {}, false, creds).codebuff_metadata.client_id;
    expect(second).toBe(first);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    const psd = executor.transformRequest("m", {}, false, { connectionId: "conn-9", providerSpecificData: { clientSessionId: "explicit" } }).codebuff_metadata.client_id;
    expect(psd).toBe("explicit");
  });

  it("import-surface: executor keeps engine-relative imports", async () => {
    const { readFileSync } = await import("node:fs");
    const text = readFileSync(new URL("../../open-sse/executors/freebuff.js", import.meta.url), "utf8");
    const specs = [];
    for (const m of text.matchAll(/from ["']([^"']+)["']/g)) specs.push(m[1]);
    expect(specs.length).toBeGreaterThan(0);
    for (const s of specs) expect(s.startsWith("node:") || s.startsWith("../") || s.startsWith("./")).toBe(true);
  });
});
