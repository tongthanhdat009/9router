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
    text: () => Promise.resolve(JSON.stringify({
      status: "active",
      instanceId,
      expiresAt: iso(expiresAtMs),
      remainingMs: expiresAtMs - BASE,
      admittedAt: iso(BASE),
      accessTier: "limited",
      freebucks: { daily: { limit: 25, spent: 5, remaining: 20 } },
    })),
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
        expect(options.headers["x-freebuff-first-tab-discount"]).toBe(0);
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
    expect(JSON.parse(start.options.body)).toMatchObject({ action: "START", agentId: "base3-free-glm-5-3-flash", ancestorRunIds: [] });
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
    // Admission metadata is preserved on the seat entry (goal: never discard it).
    expect(entry.accessTier).toBe("limited");
    expect(entry.freebucks.daily.remaining).toBe(20);
    expect(entry.remainingMs).toBe(30 * 60 * 1000);
    expect(entry.admittedAt).toBe(iso(BASE));
    await vi.advanceTimersByTimeAsync(33_000); // heartbeat period is 30s +/- 2s
    expect(entry.expiresAt).toBe(BASE + 2 * 60 * 60 * 1000);
    // Compact heartbeat omits freebucks/accessTier/remainingMs/admittedAt: carry forward, never blank.
    expect(entry.freebucks.daily.remaining).toBe(20);
    expect(entry.accessTier).toBe("limited");
    expect(entry.remainingMs).toBe(30 * 60 * 1000);
    expect(entry.admittedAt).toBe(iso(BASE));
    const again = await ensureFreeSession(creds(), MODEL, console);
    expect(again).toBe(entry);
    expect(again.freebucks.daily.remaining).toBe(20);
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

  it("purges the seat when the heartbeat reports the seat gone and the next request re-admits exactly once", async () => {
    const executor = new FreebuffExecutor();
    let admissions = 0;
    const chatInstances = [];
    let heartbeats = 0;
    vi.mocked(proxyAwareFetch).mockImplementation(async (url, options = {}) => {
      if (url === ADMISSION_URL) {
        admissions += 1;
        return admissionOk("inst-gone-" + admissions, BASE + 60 * 60 * 1000);
      }
      if (url === SESSION_URL && options.method === "GET") {
        heartbeats += 1;
        if (heartbeats === 1) return { ok: false, status: 404, statusText: "Not Found", headers: new Headers(), text: () => Promise.resolve("") };
        return sessionResponse({ status: "active", expiresAt: iso(BASE + 2 * 60 * 60 * 1000) });
      }
      if (url === AGENT_RUNS) return startOk();
      if (url === CHAT_URL) {
        const body = JSON.parse(options.body);
        chatInstances.push(body.codebuff_metadata.freebuff_instance_id);
        return new Response(JSON.stringify({ choices: [] }), { status: 200 });
      }
      throw new Error("unexpected fetch " + url + " " + options.method);
    });
    const first = await runExecutor(executor);
    await first.response.text();
    expect(chatInstances[0]).toBe("inst-gone-1");
    await vi.advanceTimersByTimeAsync(33_000); // heartbeat fires -> 404 -> purge
    const second = await runExecutor(executor);
    await second.response.text();
    expect(admissions).toBe(2);
    expect(chatInstances[1]).toBe("inst-gone-2");
    expect(chatInstances[1]).not.toBe(chatInstances[0]);
    const third = await runExecutor(executor);
    await third.response.text();
    expect(admissions).toBe(2); // S2 reused, no admit storm
    expect(chatInstances[2]).toBe("inst-gone-2");
  });

  it("keeps the seat when the heartbeat fails transiently (429/5xx)", async () => {
    const executor = new FreebuffExecutor();
    let admissions = 0;
    const chatInstances = [];
    let heartbeats = 0;
    vi.mocked(proxyAwareFetch).mockImplementation(async (url, options = {}) => {
      if (url === ADMISSION_URL) {
        admissions += 1;
        return admissionOk("inst-keep", BASE + 60 * 60 * 1000);
      }
      if (url === SESSION_URL && options.method === "GET") {
        heartbeats += 1;
        if (heartbeats === 1) return { ok: false, status: 429, statusText: "Too Many Requests", headers: new Headers(), text: () => Promise.resolve("") };
        return sessionResponse({ status: "active", expiresAt: iso(BASE + 2 * 60 * 60 * 1000) });
      }
      if (url === AGENT_RUNS) return startOk();
      if (url === CHAT_URL) {
        const body = JSON.parse(options.body);
        chatInstances.push(body.codebuff_metadata.freebuff_instance_id);
        return new Response(JSON.stringify({ choices: [] }), { status: 200 });
      }
      throw new Error("unexpected fetch " + url + " " + options.method);
    });
    const first = await runExecutor(executor);
    await first.response.text();
    await vi.advanceTimersByTimeAsync(33_000); // heartbeat fires -> 429 -> keep
    const second = await runExecutor(executor);
    await second.response.text();
    expect(admissions).toBe(1);
    expect(second.response.status).toBe(200);
    expect(chatInstances).toEqual(["inst-keep", "inst-keep"]); // same S1 reused
  });

  it("purges the seat and surfaces the error when chat returns a terminal gate rejection", async () => {
    const executor = new FreebuffExecutor();
    let admissions = 0;
    const chatInstances = [];
    let gateMode = false;
    vi.mocked(proxyAwareFetch).mockImplementation(async (url, options = {}) => {
      if (url === ADMISSION_URL) {
        admissions += 1;
        return admissionOk("inst-gate-" + admissions, BASE + 60 * 60 * 1000);
      }
      if (url === SESSION_URL && options.method === "GET") return sessionResponse({ status: "active", expiresAt: iso(BASE + 2 * 60 * 60 * 1000) });
      if (url === AGENT_RUNS) return startOk();
      if (url === CHAT_URL) {
        if (gateMode) {
          return {
            ok: false,
            status: 410,
            statusText: "Gone",
            headers: new Headers({ "Content-Type": "application/json" }),
            text: () => Promise.resolve(JSON.stringify({ error: "session_expired", message: "session expired" })),
          };
        }
        const body = JSON.parse(options.body);
        chatInstances.push(body.codebuff_metadata.freebuff_instance_id);
        return new Response(JSON.stringify({ choices: [] }), { status: 200 });
      }
      throw new Error("unexpected fetch " + url + " " + options.method);
    });
    const first = await runExecutor(executor);
    await first.response.text();
    expect(chatInstances[0]).toBe("inst-gate-1");
    gateMode = true;
    const gated = await runExecutor(executor);
    // Identical response surfaced: status + body + headers preserved, never swallowed into a retry.
    expect(gated.response.status).toBe(410);
    expect(gated.response.headers.get("content-type")).toBe("application/json");
    expect(await gated.response.json()).toEqual({ error: "session_expired", message: "session expired" });
    expect(admissions).toBe(1); // no same-turn retry
    // S1 is gone: next turn admits S2 exactly once and stays on it.
    gateMode = false;
    const second = await runExecutor(executor);
    await second.response.text();
    expect(admissions).toBe(2);
    expect(chatInstances[1]).toBe("inst-gate-2");
    const third = await runExecutor(executor);
    await third.response.text();
    expect(admissions).toBe(2);
    expect(chatInstances[2]).toBe("inst-gate-2");
  });

  it("keeps the seat on non-session chat errors (incl. code/status half-matches)", async () => {
    const cases = [
      ["session_limit_reached 409 (row fine)", 409, { error: "session_limit_reached" }],
      ["waiting_room_queued 429 (transient)", 429, { error: "waiting_room_queued" }],
      ["model_unavailable 410 (request-terminal)", 410, { error: "model_unavailable" }],
      ["plain 500 boom", 500, { error: "boom" }],
      ["session_expired code + 500 status (must BOTH match)", 500, { error: "session_expired" }],
      ["nested OpenAI-style code with wrong status", 500, { error: { code: "session_expired", message: "x" } }],
    ];
    for (const [name, status, payload] of cases) {
      _resetSessionsForTests();
      vi.mocked(proxyAwareFetch).mockReset();
      let admissions = 0;
      let chatFails = true;
      const chatInstances = [];
      vi.mocked(proxyAwareFetch).mockImplementation(async (url, options = {}) => {
        if (url === ADMISSION_URL) {
          admissions += 1;
          return admissionOk("inst-nk", BASE + 60 * 60 * 1000);
        }
        if (url === SESSION_URL && options.method === "GET") return sessionResponse({ status: "active", expiresAt: iso(BASE + 2 * 60 * 60 * 1000) });
        if (url === AGENT_RUNS) return startOk();
        if (url === CHAT_URL) {
          if (chatFails) {
            return {
              ok: false,
              status,
              statusText: "Err",
              headers: new Headers({ "Content-Type": "application/json" }),
              text: () => Promise.resolve(JSON.stringify(payload)),
            };
          }
          const body = JSON.parse(options.body);
          chatInstances.push(body.codebuff_metadata.freebuff_instance_id);
          return new Response(JSON.stringify({ choices: [] }), { status: 200 });
        }
        throw new Error("unexpected fetch " + url + " " + options.method);
      });
      const executor = new FreebuffExecutor();
      // Turn 1: chat gates -> error surfaced, but the seat must SURVIVE every case.
      const first = await runExecutor(executor);
      expect(first.response.status, name).toBe(status);
      // Turn 2: chat 200 -> S1 reused with ZERO further admissions.
      chatFails = false;
      const second = await runExecutor(executor);
      await second.response.text();
      expect(second.response.status, name).toBe(200);
      expect(admissions, name).toBe(1);
      expect(chatInstances, name).toEqual(["inst-nk"]);
    }
  });

  it("purges the seat on a terminal gate rejection with nested error.code", async () => {
    const executor = new FreebuffExecutor();
    let admissions = 0;
    let gateMode = false;
    vi.mocked(proxyAwareFetch).mockImplementation(async (url, options = {}) => {
      if (url === ADMISSION_URL) {
        admissions += 1;
        return admissionOk("inst-nested-" + admissions, BASE + 60 * 60 * 1000);
      }
      if (url === SESSION_URL && options.method === "GET") return sessionResponse({ status: "active", expiresAt: iso(BASE + 2 * 60 * 60 * 1000) });
      if (url === AGENT_RUNS) return startOk();
      if (url === CHAT_URL) {
        if (gateMode) {
          return {
            ok: false,
            status: 409,
            statusText: "Conflict",
            headers: new Headers({ "Content-Type": "application/json" }),
            text: () => Promise.resolve(JSON.stringify({ error: { code: "session_superseded", message: "taken over" } })),
          };
        }
        return new Response(JSON.stringify({ choices: [] }), { status: 200 });
      }
      throw new Error("unexpected fetch " + url + " " + options.method);
    });
    const first = await runExecutor(executor);
    await first.response.text();
    gateMode = true;
    const gated = await runExecutor(executor);
    expect(gated.response.status).toBe(409);
    expect(admissions).toBe(1);
    gateMode = false;
    const second = await runExecutor(executor);
    await second.response.text();
    expect(admissions).toBe(2);
    expect(second.response.status).toBe(200);
  });

  it("paid-mode non-ok chat responses pass through without seat handling", async () => {
    const executor = new FreebuffExecutor();
    const paid = creds({ costMode: "normal" });
    const calls = [];
    // Mock the chat transport directly (super.execute), not the raw fetch:
    // START answers through the proxyAwareFetch mock below (like every other
    // test in this file); the spy only replaces the chat leg.
    const superExecute = vi.spyOn(Object.getPrototypeOf(FreebuffExecutor.prototype), "execute").mockImplementation(async (args) => {
      calls.push("chat");
      return {
        response: {
          ok: false,
          status: 502,
          statusText: "Bad Gateway",
          headers: new Headers({ "Content-Type": "application/json" }),
          text: () => Promise.resolve(JSON.stringify({ error: "session_expired" })),
        },
      };
    });
    vi.mocked(proxyAwareFetch).mockImplementation(async (url) => {
      calls.push(String(url));
      if (url === AGENT_RUNS) return startOk();
      throw new Error("unexpected raw fetch " + url);
    });
    const result = await executor.execute({
      model: MODEL,
      body: { model: MODEL, messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: paid,
      log: console,
      proxyOptions: null,
    });
    superExecute.mockRestore();
    expect(result.response.status).toBe(502);
    expect(await result.response.json()).toEqual({ error: "session_expired" });
    expect(calls).toContain("chat");
    expect(calls.filter((u) => u === ADMISSION_URL)).toEqual([]); // session null: no admission ever
  });

  it("purges the seat on chat 409 session_superseded", async () => {
    const executor = new FreebuffExecutor();
    let admissions = 0;
    let gateMode = false;
    vi.mocked(proxyAwareFetch).mockImplementation(async (url, options = {}) => {
      if (url === ADMISSION_URL) {
        admissions += 1;
        return admissionOk("inst-sup-" + admissions, BASE + 60 * 60 * 1000);
      }
      if (url === SESSION_URL && options.method === "GET") return sessionResponse({ status: "active", expiresAt: iso(BASE + 2 * 60 * 60 * 1000) });
      if (url === AGENT_RUNS) return startOk();
      if (url === CHAT_URL) {
        if (gateMode) {
          return {
            ok: false,
            status: 409,
            statusText: "Conflict",
            headers: new Headers({ "Content-Type": "application/json" }),
            text: () => Promise.resolve(JSON.stringify({ error: "session_superseded", message: "taken over" })),
          };
        }
        return new Response(JSON.stringify({ choices: [] }), { status: 200 });
      }
      throw new Error("unexpected fetch " + url + " " + options.method);
    });
    const first = await runExecutor(executor);
    await first.response.text();
    gateMode = true;
    const gated = await runExecutor(executor);
    expect(gated.response.status).toBe(409);
    expect(admissions).toBe(1);
    gateMode = false;
    const second = await runExecutor(executor);
    await second.response.text();
    expect(admissions).toBe(2); // next-request auto-admit (gateway fresh-seat behavior)
    expect(second.response.status).toBe(200);
  });

  it("a stale S1 chat gate error cannot purge the S2 replacement seat", async () => {
    const executor = new FreebuffExecutor();
    let admissions = 0;
    let chatGatePayload = null;
    let resolveS1Chat = null;
    vi.mocked(proxyAwareFetch).mockImplementation(async (url, options = {}) => {
      if (url === ADMISSION_URL) {
        admissions += 1;
        return admissionOk("inst-stale-" + admissions, BASE + 60 * 60 * 1000);
      }
      if (url === SESSION_URL && options.method === "GET") {
        // One heartbeat: the S1 heartbeat fires 404 (purge S1), arming the race.
        return { ok: false, status: 404, statusText: "Not Found", headers: new Headers(), text: () => Promise.resolve("") };
      }
      if (url === AGENT_RUNS) return startOk();
      if (url === CHAT_URL) {
        if (chatGatePayload === "deferred") {
          // S1 chat hangs until released below.
          await new Promise((resolve) => { resolveS1Chat = resolve; });
          return {
            ok: false,
            status: 410,
            statusText: "Gone",
            headers: new Headers({ "Content-Type": "application/json" }),
            text: () => Promise.resolve(JSON.stringify({ error: "session_expired", message: "gone" })),
          };
        }
        const body = JSON.parse(options.body);
        return new Response(JSON.stringify({ inst: body.codebuff_metadata.freebuff_instance_id, choices: [] }), { status: 200 });
      }
      throw new Error("unexpected fetch " + url + " " + options.method);
    });
    // Turn 1 on S1; its chat leg is deferred so it stays in flight.
    chatGatePayload = "deferred";
    const s1 = runExecutor(executor);
    await Promise.resolve();
    await Promise.resolve();
    // Heartbeat 404 purges S1 (identity guard passes: map still S1).
    await vi.advanceTimersByTimeAsync(33_000);
    // Turn 2 admits S2 exactly once.
    chatGatePayload = null;
    const s2 = await runExecutor(executor);
    await s2.response.text();
    expect(admissions).toBe(2);
    // Now the stale S1 chat resolves with a terminal gate error. S2 must survive.
    resolveS1Chat();
    const s1Result = await s1;
    expect(s1Result.response.status).toBe(410); // surfaced, not swallowed
    // Turn 3 must reuse S2 with zero further admissions.
    const s3 = await runExecutor(executor);
    await s3.response.text();
    expect(admissions).toBe(2);
    const third = await ensureFreeSession(creds(), MODEL, console);
    expect(third.instanceId).toBe("inst-stale-2");
  });

  it("a stale S1 heartbeat cannot purge the S2 replacement seat", async () => {
    let admissions = 0;
    let heartbeatPayload = { status: "active", expiresAt: iso(BASE + 60 * 60 * 1000) };
    let releaseHeartbeat = null;
    vi.mocked(proxyAwareFetch).mockImplementation(async (url, options = {}) => {
      if (url === ADMISSION_URL) {
        admissions += 1;
        return admissionOk("inst-hstale-" + admissions, BASE + 60 * 60 * 1000);
      }
      if (url === SESSION_URL && options.method === "GET") {
        if (heartbeatPayload === "deferred") {
          await new Promise((resolve) => { releaseHeartbeat = resolve; });
          return sessionResponse({ status: "superseded" });
        }
        return sessionResponse(heartbeatPayload);
      }
      throw new Error("unexpected fetch " + url + " " + options.method);
    });
    const s1 = await ensureFreeSession(creds(), MODEL, console);
    expect(s1.instanceId).toBe("inst-hstale-1");
    // The S1 heartbeat is deferred; release it to report superseded and force
    // S2. A SECOND S1 timer armed while the deferred GET waited stays pending;
    heartbeatPayload = "deferred";
    // Prime: let the timer fire while the GET waits (vi.advanceTimersByTimeAsync
    // flushes the 30s timer only after the fake clock passes the period).
    let hb = vi.advanceTimersByTimeAsync(33_000);
    await hb.catch(() => {});
    for (let i = 0; i < 50 && !releaseHeartbeat; i++) await vi.advanceTimersByTimeAsync(0);
    expect(releaseHeartbeat, "heartbeat did not start").toBeTypeOf("function");
    hb = (async () => { releaseHeartbeat(); await vi.advanceTimersByTimeAsync(0); })();
    await hb; // stale S1 heartbeat resolves superseded -> S1 purged
    expect(admissions).toBe(1);
    const s2 = await ensureFreeSession(creds(), MODEL, console);
    expect(s2.instanceId).toBe("inst-hstale-2");
    expect(admissions).toBe(2);
    // Stale heartbeats of the REPLACED S1 generation (armed while S1 waited) must
    // not purge S2: they carry the old entry object, identity guard holds.
    heartbeatPayload = { status: "active", expiresAt: iso(BASE + 60 * 60 * 1000) }; // new polls neutral
    await vi.advanceTimersByTimeAsync(33_000);
    const still = await ensureFreeSession(creds(), MODEL, console);
    expect(still).toBe(s2);
    expect(admissions).toBe(2);
  });

  it("a stale S1 heartbeat ended status cannot end the S2 replacement seat", async () => {
    const executor = new FreebuffExecutor();
    let admissions = 0;
    let chatFails = false;
    let heartbeatPayload = { status: "active", expiresAt: iso(BASE + 60 * 60 * 1000) };
    let releaseHeartbeat = null;
    vi.mocked(proxyAwareFetch).mockImplementation(async (url, options = {}) => {
      if (url === ADMISSION_URL) {
        admissions += 1;
        return admissionOk("inst-estale-" + admissions, BASE + 60 * 60 * 1000);
      }
      if (url === SESSION_URL && options.method === "GET") {
        if (heartbeatPayload === "deferred") {
          await new Promise((resolve) => { releaseHeartbeat = resolve; });
          return sessionResponse({ status: "ended", expiresAt: iso(BASE - 60 * 1000) });
        }
        return sessionResponse(heartbeatPayload);
      }
      if (url === AGENT_RUNS) return startOk();
      if (url === CHAT_URL) {
        if (chatFails) {
          return { ok: false, status: 410, statusText: "Gone", headers: new Headers({ "Content-Type": "application/json" }), text: () => Promise.resolve(JSON.stringify({ error: "session_expired", message: "gone" })) };
        }
        return new Response(JSON.stringify({ choices: [] }), { status: 200 });
      }
      throw new Error("unexpected fetch " + url + " " + options.method);
    });
    // Turn 1 admits S1 and arms its heartbeat timer.
    const t1 = await runExecutor(executor);
    await t1.response.text();
    expect(admissions).toBe(1);
    // S1's heartbeat GET hangs in flight.
    heartbeatPayload = "deferred";
    await vi.advanceTimersByTimeAsync(33_000);
    for (let i = 0; i < 50 && !releaseHeartbeat; i++) await vi.advanceTimersByTimeAsync(0);
    expect(releaseHeartbeat, "heartbeat did not start").toBeTypeOf("function");
    // While it hangs, the chat gate purges S1 and the next turn admits S2.
    chatFails = true;
    const gated = await runExecutor(executor);
    expect(gated.response.status).toBe(410); // surfaced, not swallowed; seat purged
    chatFails = false;
    const t3 = await runExecutor(executor);
    await t3.response.text();
    expect(admissions).toBe(2);
    const s2 = await ensureFreeSession(creds(), MODEL, console);
    expect(s2.instanceId).toBe("inst-estale-2");
    // The stale S1 heartbeat finally resolves with "ended": the identity guard
    // must leave the healthy S2 untouched (no ended status, no grace window).
    heartbeatPayload = { status: "active", expiresAt: iso(BASE + 60 * 60 * 1000) };
    const hb = (async () => { releaseHeartbeat(); await vi.advanceTimersByTimeAsync(0); })();
    await hb;
    await vi.advanceTimersByTimeAsync(0);
    expect(s2.status).not.toBe("ended");
    expect(s2.graceUntil).toBeUndefined();
    const still = await ensureFreeSession(creds(), MODEL, console);
    expect(still).toBe(s2);
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
    expect(del.headers).not.toHaveProperty("x-freebuff-compact-session");
    // Call order: first admission, then DELETE release, then re-admission.
    const admissionIdx = [];
    seen.forEach((c, i) => { if (c.url === ADMISSION_URL) admissionIdx.push(i); });
    expect(admissionIdx).toHaveLength(2);
    expect(seen.indexOf(del)).toBeGreaterThan(admissionIdx[0]);
    expect(seen.indexOf(del)).toBeLessThan(admissionIdx[1]);
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

  it("refuses an anonymous seat when credentials carry no connectionId", async () => {
    const executor = new FreebuffExecutor();
    const noId = { accessToken: "free-token", providerSpecificData: { userId: "u-1" } };
    const calls = [];
    vi.mocked(proxyAwareFetch).mockImplementation(async (url) => {
      calls.push(String(url));
      throw new Error("unexpected fetch " + url);
    });
    // (a) Through the executor: 400 contract, zero upstream traffic.
    const result = await runExecutor(executor, { creds: noId });
    expect(result.response.status).toBe(400);
    expect(await result.response.text()).toContain("connectionId missing");
    expect(calls).toEqual([]);
    // (b) Direct call: the exported seat manager throws too — no shared undefined key.
    // (FreebuffSessionError.message is the generic admission prefix; the contract lives in bodyText.)
    const direct = await ensureFreeSession(noId, MODEL, null).catch((e) => e);
    expect(direct).toBeInstanceOf(FreebuffSessionError);
    expect(direct.status).toBe(400);
    expect(direct.bodyText).toContain("connectionId missing");
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

  // --- Tool passthrough evidence (live probes 2026-09-21/22, GLM 5.3 Flash free lane) ---
  // Mixed Buffy+foreign toolsets are NOT rejected at admission (detector runs per-request
  // and did not fire); foreign-only toolset -> 404; strict:true -> 404; upstream MAY answer
  // plain text with no tool_calls (KNOWN-LIMIT, client-visible, not a 9router bug).
  // 9router itself must never mutate or synthesize tool calls.
describe("FreeBuff free-session tool passthrough evidence", () => {
  const BUFFY_WRITE_TODOS = {
    type: "function",
    function: {
      name: "write_todos",
      description: "Write the todo list for the current task.",
      parameters: { type: "object", properties: { todos: { type: "array", items: { type: "object" } } }, required: ["todos"] },
    },
  };
  const FOREIGN_LOOKUP_ORDER = {
    type: "function",
    function: {
      name: "lookup_order",
      description: "Look up a customer order by id.",
      parameters: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] },
    },
  };

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

  function mockFreeLane(chatPayload) {
    const calls = [];
    vi.mocked(proxyAwareFetch).mockImplementation(async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (url === ADMISSION_URL) return admissionOk("inst-tools", BASE + 60 * 60 * 1000);
      if (url === AGENT_RUNS) return startOk(); // START and FINISH
      if (url === CHAT_URL) return new Response(JSON.stringify(chatPayload), { status: 200 });
      throw new Error("unexpected fetch " + url);
    });
    return calls;
  }

  async function chatBodyWith({ tools, toolChoice = "auto", extraBody = {}, chatPayload } = {}) {
    const executor = new FreebuffExecutor();
    const calls = mockFreeLane(chatPayload || { choices: [{ message: { role: "assistant", content: "ok" } }] });
    const body = {
      model: MODEL,
      messages: [{ role: "user", content: "list my todos then check order 42" }],
      ...(tools ? { tools, tool_choice: toolChoice } : {}),
      ...extraBody,
    };
    const result = await executor.execute({ model: MODEL, body, stream: false, credentials: creds(), log: console, proxyOptions: null });
    expect(result.response.status).toBe(200); // mixed toolsets are NOT auto-rejected at admission
    const text = await result.response.text(); // drain so the terminal FINISH settles
    const start = calls.find((c) => c.url === AGENT_RUNS && JSON.parse(c.options.body).action === "START");
    expect(JSON.parse(start.options.body).agentId).toBe("base3-free-glm-5-3-flash");
    const chatCall = calls.find((c) => c.url === CHAT_URL);
    return { chatBody: JSON.parse(chatCall.options.body), text };
  }

  it("passes mixed Buffy+foreign tools through UNMODIFIED (byte-equal)", async () => {
    const mixed = [BUFFY_WRITE_TODOS, FOREIGN_LOOKUP_ORDER];
    const { chatBody } = await chatBodyWith({ tools: mixed });
    expect(chatBody.tools).toEqual(mixed);
    expect(JSON.stringify(chatBody.tools)).toBe(JSON.stringify(mixed));
    expect(chatBody.tool_choice).toBe("auto");
    expect(chatBody.codebuff_metadata.cost_mode).toBe("free");
  });

  it("passes the strict flag through unmodified (upstream decides)", async () => {
    const strictForeign = { ...FOREIGN_LOOKUP_ORDER, function: { ...FOREIGN_LOOKUP_ORDER.function, strict: true } };
    const { chatBody } = await chatBodyWith({ tools: [BUFFY_WRITE_TODOS, strictForeign] });
    expect(chatBody.tools[1].function.strict).toBe(true);
    expect(JSON.stringify(chatBody.tools)).toBe(JSON.stringify([BUFFY_WRITE_TODOS, strictForeign]));
  });

  it("passes no-tools chat through untouched", async () => {
    const { chatBody } = await chatBodyWith({});
    expect(chatBody.tools).toBeUndefined();
    expect(chatBody.tool_choice).toBeUndefined();
    expect(chatBody.messages).toHaveLength(2); // Buffy system prepend + user
    expect(chatBody.codebuff_metadata.cost_mode).toBe("free");
  });

  it("KNOWN-LIMIT: upstream may answer text with no tool_calls (client-visible, not a 9router bug)", async () => {
    const { chatBody, text } = await chatBodyWith({
      tools: [BUFFY_WRITE_TODOS],
      chatPayload: { choices: [{ message: { role: "assistant", content: "I will check that for you." } }] },
    });
    expect(chatBody.tools).toHaveLength(1); // we forwarded the tool; upstream chose text
    const payload = JSON.parse(text);
    expect(payload.choices[0].message.tool_calls).toBeUndefined(); // never synthesized by 9router
    expect(payload.choices[0].message.content).toBe("I will check that for you.");
  });

});



// --- Outbound transport boundary: FINAL headers observed at the mocked
// proxyAwareFetch call (lifecycleFetch only merges signal and passthroughs
// headers byte-for-byte, so options.headers here IS the wire shape). ---
describe("FreeBuff outbound transport boundary", () => {
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

  it("admission POST carries exactly the 5 session headers and no Content-Type", async () => {
    const calls = [];
    vi.mocked(proxyAwareFetch).mockImplementation(async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (url === ADMISSION_URL) return admissionOk("inst-boundary", BASE + 60 * 60 * 1000);
      throw new Error("unexpected fetch " + url);
    });
    await ensureFreeSession(creds(), MODEL, console);
    const admission = calls.find((c) => c.url === ADMISSION_URL);
    expect(admission.options.method).toBe("POST");
    expect(Object.keys(admission.options.headers).sort()).toEqual([
      "Authorization",
      "x-fb-timezone",
      "x-freebuff-first-tab-discount",
      "x-freebuff-model",
      "x-freebuff-wallet-spend-limit",
    ]);
    expect(admission.options.headers.Authorization).toBe("Bearer free-token");
    expect(admission.options.headers["x-fb-timezone"]).toBeTruthy(); // IANA zone or UTC
    expect(admission.options.headers["x-freebuff-first-tab-discount"]).toBe(0);
    expect(admission.options.headers["x-freebuff-model"]).toBe(MODEL);
    expect(admission.options.headers["x-freebuff-wallet-spend-limit"]).toBe("0");
    expect(admission.options.headers["Content-Type"]).toBeUndefined();
  });

  it("heartbeat GET carries exactly the 5 compact headers", async () => {
    const calls = [];
    vi.mocked(proxyAwareFetch).mockImplementation(async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (url === ADMISSION_URL) return admissionOk("inst-hb-boundary", BASE + 60 * 60 * 1000);
      if (url === SESSION_URL && options.method === "GET") return sessionResponse({ status: "active", expiresAt: iso(BASE + 2 * 60 * 60 * 1000) });
      throw new Error("unexpected fetch " + url + " " + options.method);
    });
    await ensureFreeSession(creds(), MODEL, console);
    await vi.advanceTimersByTimeAsync(33_000); // heartbeat period is 30s +/- 2s
    const heartbeat = calls.find((c) => c.url === SESSION_URL && c.options.method === "GET");
    expect(heartbeat).toBeDefined();
    expect(Object.keys(heartbeat.options.headers).sort()).toEqual([
      "Authorization",
      "x-fb-timezone",
      "x-freebuff-compact-session",
      "x-freebuff-first-tab-discount",
      "x-freebuff-instance-id",
    ]);
    expect(heartbeat.options.headers.Authorization).toBe("Bearer free-token");
    expect(heartbeat.options.headers["x-fb-timezone"]).toBeTruthy();
    expect(heartbeat.options.headers["x-freebuff-first-tab-discount"]).toBe(0);
    expect(heartbeat.options.headers["x-freebuff-instance-id"]).toBe("inst-hb-boundary");
    expect(heartbeat.options.headers["x-freebuff-compact-session"]).toBe("1");
  });

  it("DELETE release on model switch carries exactly the 4 session headers and never compact", async () => {
    const seen = [];
    vi.mocked(proxyAwareFetch).mockImplementation(async (url, options = {}) => {
      seen.push({ url: String(url), method: options.method, headers: options.headers });
      if (url === ADMISSION_URL) {
        return admissionOk(options.headers["x-freebuff-model"] === "mimo/mimo-v2.5" ? "inst-mimo-del" : "inst-glm-del", BASE + 60 * 60 * 1000);
      }
      if (url === SESSION_URL && options.method === "DELETE") return sessionResponse({ status: "ended" });
      throw new Error("unexpected fetch " + url + " " + options.method);
    });
    await ensureFreeSession(creds(), MODEL, console);
    const second = await ensureFreeSession(creds(), "mimo/mimo-v2.5", console);
    expect(second.instanceId).toBe("inst-mimo-del");
    const del = seen.find((c) => c.method === "DELETE");
    expect(del.url).toBe(SESSION_URL);
    expect(Object.keys(del.headers).sort()).toEqual([
      "Authorization",
      "x-fb-timezone",
      "x-freebuff-first-tab-discount",
      "x-freebuff-instance-id",
    ]);
    expect(del.headers.Authorization).toBe("Bearer free-token");
    expect(del.headers["x-fb-timezone"]).toBeTruthy();
    expect(del.headers["x-freebuff-first-tab-discount"]).toBe(0);
    expect(del.headers["x-freebuff-instance-id"]).toBe("inst-glm-del"); // the OLD seat
    expect(del.headers).not.toHaveProperty("x-freebuff-compact-session");
  });

  it("START POST carries Content-Type, Authorization, and acting-user on the agent-runs call", async () => {
    const calls = [];
    vi.mocked(proxyAwareFetch).mockImplementation(async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (url === ADMISSION_URL) return admissionOk("inst-start", BASE + 60 * 60 * 1000);
      if (url === AGENT_RUNS) return startOk(); // START and FINISH
      if (url === CHAT_URL) return new Response(JSON.stringify({ choices: [] }), { status: 200 });
      throw new Error("unexpected fetch " + url);
    });
    const executor = new FreebuffExecutor();
    const result = await runExecutor(executor);
    expect(result.response.status).toBe(200);
    await result.response.text(); // drain so the terminal FINISH settles
    const start = calls.find((c) => c.url === AGENT_RUNS && JSON.parse(c.options.body).action === "START");
    expect(start.options.method).toBe("POST");
    expect(start.options.headers["Content-Type"]).toBe("application/json");
    expect(start.options.headers.Authorization).toBe("Bearer free-token");
    expect(start.options.headers["x-freebuff-acting-user-id"]).toBe("u-1");
  });

  it("chat POST carries Authorization and acting-user on the 200 path", async () => {
    const calls = [];
    vi.mocked(proxyAwareFetch).mockImplementation(async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (url === ADMISSION_URL) return admissionOk("inst-chat", BASE + 60 * 60 * 1000);
      if (url === AGENT_RUNS) return startOk(); // START and FINISH
      if (url === CHAT_URL) return new Response(JSON.stringify({ choices: [] }), { status: 200 });
      throw new Error("unexpected fetch " + url);
    });
    const executor = new FreebuffExecutor();
    const result = await runExecutor(executor);
    expect(result.response.status).toBe(200);
    await result.response.text();
    const chatCall = calls.find((c) => c.url === CHAT_URL);
    expect(chatCall.options.method).toBe("POST");
    expect(chatCall.options.headers.Authorization).toBe("Bearer free-token");
    expect(chatCall.options.headers["x-freebuff-acting-user-id"]).toBe("u-1");
  });

  it("chat POST carries the official codebuff user-agent marker; session calls keep runtime default", async () => {
    const calls = [];
    vi.mocked(proxyAwareFetch).mockImplementation(async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (url === ADMISSION_URL) return admissionOk("inst-ua", BASE + 60 * 60 * 1000);
      if (url === AGENT_RUNS) return startOk(); // START and FINISH
      if (url === CHAT_URL) return new Response(JSON.stringify({ choices: [] }), { status: 200 });
      throw new Error("unexpected fetch " + url);
    });
    const executor = new FreebuffExecutor();
    const result = await runExecutor(executor);
    expect(result.response.status).toBe(200);
    await result.response.text();
    const chatCall = calls.find((c) => c.url === CHAT_URL);
    // Wire marker from sdk model-provider.ts:310 @ bfe8408, stamped by the
    // executor buildHeaders override before base.execute dispatches.
    expect(chatCall.options.headers["user-agent"]).toBe("ai-sdk/openai-compatible/0.10.7/codebuff");
    // Non-chat legs keep the runtime default UA: the official client only
    // stamps this marker on the chat completion call, never agent-runs/session.
    const admission = calls.find((c) => c.url === ADMISSION_URL);
    expect(admission.options.headers["user-agent"]).toBeUndefined();
    const start = calls.find((c) => c.url === AGENT_RUNS && JSON.parse(c.options.body).action === "START");
    expect(start.options.headers["user-agent"]).toBeUndefined();
  });
});
  it("FreebuffSessionError carries status, body, and parsed Retry-After", () => {
    const error = new FreebuffSessionError(403, "country_blocked", 1500);
    expect(error).toBeInstanceOf(Error);
    expect(error.status).toBe(403);
    expect(error.bodyText).toBe("country_blocked");
    expect(error.retryAfterMs).toBe(1500);
  });
});


