import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));

const { FreebuffExecutor, ensureFreeSession, _resetSessionsForTests, FREE_ROOT_BY_MODEL, FreebuffSessionError } = await import("../../open-sse/executors/freebuff.js");
const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

const ADMISSION_URL = "https://www.codebuff.com/api/v1/freebuff/session/admission";
const SESSION_URL = "https://www.codebuff.com/api/v1/freebuff/session";
const AGENT_RUNS = "https://www.codebuff.com/api/v1/agent-runs";
const CHAT_URL = "https://www.codebuff.com/api/v1/chat/completions";
const MODEL = "z-ai/glm-5.3-flash";
const BASE = Date.UTC(2026, 8, 22, 12, 0, 0);
const iso = (ms) => new Date(ms).toISOString();

function creds(overrides = {}) {
  return {
    connectionId: "conn-free",
    accessToken: "free-token",
    providerSpecificData: { userId: "u-1", ...overrides },
  };
}

function admissionOk(instanceId, expiresAtMs) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    text: () => Promise.resolve(JSON.stringify({ status: "active", instanceId, expiresAt: iso(expiresAtMs), remainingMs: expiresAtMs - BASE })),
  };
}

function sessionResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    headers: new Headers(),
    text: () => Promise.resolve(JSON.stringify(payload)),
  };
}

function startOk() {
  return { ok: true, status: 200, statusText: "OK", text: () => Promise.resolve(JSON.stringify({ runId: "run-f" })) };
}

async function runExecutor(executor, opts = {}) {
  const m = opts.model || MODEL;
  return executor.execute({
    model: m,
    body: { model: m, messages: opts.messages || [{ role: "user", content: "hi" }] },
    stream: false,
    credentials: opts.creds || creds(),
    log: console,
    proxyOptions: null,
  });
}

describe("FreeBuff free-session mode", () => {
  beforeEach(() => {
    vi.mocked(proxyAwareFetch).mockReset();
    _resetSessionsForTests();
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
  });

  afterEach(() => {
    _resetSessionsForTests();
    vi.useRealTimers();
  });
  it("admits a session and the chat carries instance id, free cost mode, Buffy system, and the free-root agentId", async () => {
    const executor = new FreebuffExecutor();
    const calls = [];
    vi.mocked(proxyAwareFetch).mockImplementation(async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (url === ADMISSION_URL) {
        expect(options.method).toBe("POST");
        expect(options.headers.Authorization).toBe("Bearer free-token");
        expect(options.headers["x-fb-timezone"]).toBeTruthy();
        expect(options.headers["x-freebuff-first-tab-discount"]).toBe("0");
        expect(options.headers["x-freebuff-model"]).toBe(MODEL);
        expect(options.headers["x-freebuff-wallet-spend-limit"]).toBe("0");
        expect(options.body).toBeUndefined();
        return admissionOk("inst-1", BASE + 60 * 60 * 1000);
      }
      if (url === AGENT_RUNS) return startOk(); // START and FINISH
      if (url === CHAT_URL) return new Response(JSON.stringify({ choices: [] }), { status: 200 });
      throw new Error("unexpected fetch " + url);
    });
    const systemText = "You are Claude Code, Anthropic's official CLI for Claude.";
    const result = await runExecutor(executor, { messages: [{ role: "system", content: systemText }, { role: "user", content: "hi" }] });
    await result.response.text(); // drain so the terminal FINISH settles
    const start = calls.find((c) => c.url === AGENT_RUNS && JSON.parse(c.options.body).action === "START");
    expect(JSON.parse(start.options.body)).toMatchObject({ action: "START", agentId: "base3-free-glm-5-3-flash" });
    const chatCall = calls.find((c) => c.url === CHAT_URL);
    const chatBody = JSON.parse(chatCall.options.body);
    expect(chatBody.codebuff_metadata.freebuff_instance_id).toBe("inst-1");
    expect(chatBody.codebuff_metadata.cost_mode).toBe("free");
    // Buffy opening at byte 0; foreign-harness client system preserved after it (never stripped).
    expect(chatBody.messages[0].role).toBe("system");
    expect(chatBody.messages[0].content).toBe("You are Buffy, the coding agent behind Codebuff.\n\n" + systemText);
  });

  it("surfaces admission failure status/body with Retry-After, without chat, FINISH, or paid fallback", async () => {
    const executor = new FreebuffExecutor();
    const calls = [];
    vi.mocked(proxyAwareFetch).mockImplementation(async (url) => {
      calls.push(String(url));
      if (url === ADMISSION_URL) {
        return {
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
          headers: new Headers({ "retry-after": "7" }),
          text: () => Promise.resolve(JSON.stringify({ error: "slow down" })),
        };
      }
      throw new Error("unexpected fetch " + url);
    });
    const result = await runExecutor(executor);
    expect(result.response.status).toBe(429);
    expect(result.response.headers.get("Retry-After")).toBe("7");
    await expect(result.response.text()).resolves.toContain("slow down");
    expect(calls).toEqual([ADMISSION_URL]); // no START/chat/FINISH and never a paid retry
  });

  it("returns an actionable 400 without any upstream fetch when the free model has no verified root", async () => {
    const executor = new FreebuffExecutor();
    const calls = [];
    vi.mocked(proxyAwareFetch).mockImplementation(async (url) => {
      calls.push(String(url));
      throw new Error("unexpected fetch " + url);
    });
    const result = await runExecutor(executor, { model: "some/unknown-model" });
    expect(result.response.status).toBe(400);
    const payload = await result.response.json();
    expect(payload.error.message).toContain("FreeBuff free mode does not support model some/unknown-model");
    expect(payload.error.message).toContain("z-ai/glm-5.3-flash");
    expect(payload.error.message).toContain("Use paid mode or a supported model");
    expect(calls).toEqual([]);
  });

  it("heartbeat active refresh updates expiry and the live session is reused", async () => {
    let admissions = 0;
    vi.mocked(proxyAwareFetch).mockImplementation(async (url, options = {}) => {
      if (url === ADMISSION_URL) {
        admissions += 1;
        return admissionOk("inst-hb", BASE + 30 * 60 * 1000);
      }
      if (url === SESSION_URL && options.method === "GET") {
        expect(options.headers["x-freebuff-instance-id"]).toBe("inst-hb");
        expect(options.headers["x-freebuff-compact-session"]).toBe("1");
        return sessionResponse({ status: "active", expiresAt: iso(BASE + 2 * 60 * 60 * 1000) });
      }
      throw new Error("unexpected fetch " + url + " " + options.method);
    });
    const entry = await ensureFreeSession(creds(), MODEL, console);
    expect(entry.instanceId).toBe("inst-hb");
    expect(entry.expiresAt).toBe(BASE + 30 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(33_000); // heartbeat period is 30s +/- 2s
    expect(entry.expiresAt).toBe(BASE + 2 * 60 * 60 * 1000);
    const again = await ensureFreeSession(creds(), MODEL, console);
    expect(again).toBe(entry);
    expect(admissions).toBe(1);
  });

  it("keeps an ended session servable through the 30min grace, then purges and re-admits", async () => {
    let admissions = 0;
    vi.mocked(proxyAwareFetch).mockImplementation(async (url, options = {}) => {
      if (url === ADMISSION_URL) {
        admissions += 1;
        return admissionOk("inst-" + admissions, BASE + 30 * 60 * 1000);
      }
      if (url === SESSION_URL && options.method === "GET") return sessionResponse({ status: "ended" });
      throw new Error("unexpected fetch " + url + " " + options.method);
    });
    const entry = await ensureFreeSession(creds(), MODEL, console);
    await vi.advanceTimersByTimeAsync(33_000);
    expect(entry.status).toBe("ended");
    expect(entry.graceUntil).toBe(BASE + 30 * 60 * 1000 + 30 * 60 * 1000);
    const during = await ensureFreeSession(creds(), MODEL, console);
    expect(during).toBe(entry);
    expect(admissions).toBe(1);
    await vi.advanceTimersByTimeAsync(61 * 60 * 1000); // past graceUntil
    const after = await ensureFreeSession(creds(), MODEL, console);
    expect(after).not.toBe(entry);
    expect(after.instanceId).toBe("inst-2");
    expect(admissions).toBe(2);
  });

  it("purges the session when the heartbeat reports superseded", async () => {
    let admissions = 0;
    vi.mocked(proxyAwareFetch).mockImplementation(async (url, options = {}) => {
      if (url === ADMISSION_URL) {
        admissions += 1;
        return admissionOk("inst-s" + admissions, BASE + 60 * 60 * 1000);
      }
      if (url === SESSION_URL && options.method === "GET") return sessionResponse({ status: "superseded" });
      throw new Error("unexpected fetch " + url + " " + options.method);
    });
    const entry = await ensureFreeSession(creds(), MODEL, console);
    await vi.advanceTimersByTimeAsync(33_000);
    const next = await ensureFreeSession(creds(), MODEL, console);
    expect(next).not.toBe(entry);
    expect(next.instanceId).toBe("inst-s2");
    expect(admissions).toBe(2);
  });

  it("releases the old session with DELETE when the model switches on the same connection", async () => {
    const seen = [];
    vi.mocked(proxyAwareFetch).mockImplementation(async (url, options = {}) => {
      seen.push({ url: String(url), method: options.method, headers: options.headers });
      if (url === ADMISSION_URL) {
        return admissionOk(options.headers["x-freebuff-model"] === "mimo/mimo-v2.5" ? "inst-mimo" : "inst-glm", BASE + 60 * 60 * 1000);
      }
      if (url === SESSION_URL && options.method === "DELETE") return sessionResponse({ status: "ended" });
      throw new Error("unexpected fetch " + url + " " + options.method);
    });
    await ensureFreeSession(creds(), MODEL, console);
    const second = await ensureFreeSession(creds(), "mimo/mimo-v2.5", console);
    expect(second.instanceId).toBe("inst-mimo");
    const del = seen.find((c) => c.method === "DELETE");
    expect(del.url).toBe(SESSION_URL);
    expect(del.headers["x-freebuff-instance-id"]).toBe("inst-glm");
    expect(del.headers["x-freebuff-compact-session"]).toBe("1");
  });

  it("single-flight: two concurrent executes share one admission", async () => {
    let admissions = 0;
    vi.mocked(proxyAwareFetch).mockImplementation(async (url) => {
      if (url === ADMISSION_URL) {
        admissions += 1;
        await Promise.resolve();
        await Promise.resolve();
        return admissionOk("inst-race", BASE + 60 * 60 * 1000);
      }
      if (url === AGENT_RUNS) return startOk();
      throw new Error("unexpected fetch " + url);
    });
    const executor = new FreebuffExecutor();
    const superExecute = vi.spyOn(Object.getPrototypeOf(FreebuffExecutor.prototype), "execute").mockResolvedValue({ response: new Response(null, { status: 200 }) });
    const [a, b] = await Promise.all([runExecutor(executor), runExecutor(executor)]);
    superExecute.mockRestore();
    expect(a.response.status).toBe(200);
    expect(b.response.status).toBe(200);
    expect(admissions).toBe(1);
  });

  it("account isolation: a different accessToken purges the old session and re-admits without DELETE", async () => {
    const seen = [];
    let admissions = 0;
    vi.mocked(proxyAwareFetch).mockImplementation(async (url, options = {}) => {
      seen.push(String(url) + " " + options.method);
      if (url === ADMISSION_URL) {
        admissions += 1;
        return admissionOk("inst-a" + admissions, BASE + 60 * 60 * 1000);
      }
      throw new Error("unexpected fetch " + url + " " + options.method);
    });
    const first = await ensureFreeSession(creds(), MODEL, console);
    const other = await ensureFreeSession({ ...creds(), accessToken: "other-account-token" }, MODEL, console);
    expect(other).not.toBe(first);
    expect(other.instanceId).toBe("inst-a2");
    expect(admissions).toBe(2);
    expect(seen.filter((c) => c.endsWith("DELETE"))).toEqual([]); // never release another account's session
  });

  it("free-mode system rewrite is idempotent once canonized", async () => {
    const executor = new FreebuffExecutor();
    const c = creds();
    c.__freebuffInstanceId = "inst-x";
    const canon = "You are Buffy, the coding agent behind Codebuff.\n\nClient rules.";
    const once = executor.transformRequest(MODEL, { messages: [{ role: "system", content: canon }, { role: "user", content: "hi" }] }, false, c);
    expect(once.messages[0].content).toBe(canon);
    const twice = executor.transformRequest(MODEL, { messages: once.messages }, false, c);
    expect(twice.messages[0].content).toBe(canon);
    expect(twice.messages).toHaveLength(2);
  });

  it("deepseek free root uses the base2 opening and unshifts when no leading system message exists", async () => {
    const executor = new FreebuffExecutor();
    const c = creds();
    c.__freebuffInstanceId = "inst-d";
    expect(FREE_ROOT_BY_MODEL["deepseek/deepseek-v4.1-flash"]).toBe("base2-free-deepseek-v4-1-flash");
    const out = executor.transformRequest("deepseek/deepseek-v4.1-flash", { messages: [{ role: "user", content: "hi" }] }, false, c);
    expect(out.messages[0]).toEqual({ role: "system", content: "You are Buffy, the strategic coding assistant." });
    expect(out.messages[1]).toEqual({ role: "user", content: "hi" });
    expect(out.codebuff_metadata.cost_mode).toBe("free");
    expect(out.codebuff_metadata.freebuff_instance_id).toBe("inst-d");
  });

  it("FreebuffSessionError carries status, body, and parsed Retry-After", () => {
    const error = new FreebuffSessionError(403, "country_blocked", 1500);
    expect(error).toBeInstanceOf(Error);
    expect(error.status).toBe(403);
    expect(error.bodyText).toBe("country_blocked");
    expect(error.retryAfterMs).toBe(1500);
  });
});

