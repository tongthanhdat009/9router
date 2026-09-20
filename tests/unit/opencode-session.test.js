import { describe, expect, it } from "vitest";
import { getExecutor } from "../../open-sse/executors/index.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import {
  OPENCODE_SESSION_RE,
  OPENCODE_REQUEST_RE,
  generateSessionId,
  generateRequestId,
  translateSessionId,
  stableSessionId,
  deriveRequestId,
} from "../../open-sse/executors/opencode.js";

function makeCredentials(overrides = {}) {
  return { connectionId: "conn_test", rawHeaders: {}, ...overrides };
}

// Local seam: session/request ids resolve through deriveRequestContext (threaded
// by base.execute), not upstream prepareRequestCredentials.
function contextOf(executor, overrides = {}) {
  return executor.deriveRequestContext(
    overrides.body || { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }] },
    overrides.credentials || makeCredentials(),
  );
}

describe("OpenCode canonical session/request identity", () => {
  it("mints canonical ses_/msg_ ids", () => {
    const session = generateSessionId();
    expect(session).toMatch(OPENCODE_SESSION_RE);
    const request = generateRequestId();
    expect(request).toMatch(OPENCODE_REQUEST_RE);
    expect(generateSessionId()).not.toBe(session);
    expect(generateRequestId()).not.toBe(request);
  });

  it("translates foreign session ids deterministically per client tool and keeps canonical ones", () => {
    const canonical = "ses_0123456789abABCDEF12345678";
    expect(translateSessionId(canonical)).toBe(canonical);
    expect(translateSessionId("conversation-a", "claude")).toMatch(OPENCODE_SESSION_RE);
    expect(translateSessionId("conversation-a", "claude")).toBe(translateSessionId("conversation-a", "claude"));
    expect(translateSessionId("conversation-a", "other")).not.toBe(translateSessionId("conversation-a", "claude"));
  });

  it("keeps one stable session per connection identity", () => {
    const first = stableSessionId(makeCredentials());
    expect(first).toMatch(OPENCODE_SESSION_RE);
    expect(stableSessionId(makeCredentials())).toBe(first);
    expect(stableSessionId(makeCredentials({ connectionId: "conn_other" }))).not.toBe(first);
    expect(stableSessionId({ rawHeaders: {} })).toMatch(OPENCODE_SESSION_RE);
  });

  it("derives a retry-stable request id from session plus last user message", () => {
    const session = generateSessionId();
    const body = { messages: [{ role: "user", content: "ping" }] };
    const first = deriveRequestId(session, body);
    expect(first).toMatch(OPENCODE_REQUEST_RE);
    expect(deriveRequestId(session, body)).toBe(first);
    expect(deriveRequestId(session, { messages: [{ role: "user", content: "a different question" }] })).not.toBe(first);
  });

  it("prefers a canonical native x-opencode-session and valid x-opencode-request", () => {
    const executor = getExecutor("opencode");
    const native = "ses_0ae8d9cd3001swxaFbM248jcIF";
    const ctx = contextOf(executor, { credentials: makeCredentials({ rawHeaders: { "x-opencode-session": native } }) });
    expect(ctx.sessionId).toBe(native);

    const validReq = "msg_0ae8d9cd3001swxaFbM248jcIF";
    const reqCtx = contextOf(executor, { credentials: makeCredentials({ rawHeaders: { "x-opencode-request": validReq } }) });
    expect(reqCtx.requestId).toBe(validReq);
  });

  it("threads canonical ids through buildHeaders and keeps them retry-stable", () => {
    const executor = getExecutor("opencode");
    const credentials = makeCredentials();
    const ctx = contextOf(executor, { credentials });
    const headers = executor.buildHeaders(credentials, true, "https://opencode.ai/zen/v1/responses", "big-pickle", ctx);
    expect(headers["x-opencode-session"]).toBe(ctx.sessionId);
    expect(headers["x-opencode-session"]).toMatch(OPENCODE_SESSION_RE);
    expect(headers["x-opencode-request"]).toMatch(OPENCODE_REQUEST_RE);
    expect(headers["User-Agent"]).toMatch(/^opencode\/1\.18\.31$/);
    // Same ctx again (retry) -> identical headers.
    const again = executor.buildHeaders(credentials, true, "https://opencode.ai/zen/v1/responses", "big-pickle", ctx);
    expect(again["x-opencode-session"]).toBe(headers["x-opencode-session"]);
    expect(again["x-opencode-request"]).toBe(headers["x-opencode-request"]);
  });

  it("keeps the standalone buildHeaders session stable across calls", () => {
    const executor = getExecutor("opencode");
    const first = executor.buildHeaders({}, true)[ "x-opencode-session" ];
    const second = executor.buildHeaders({}, true)[ "x-opencode-session" ];
    expect(first).toMatch(OPENCODE_SESSION_RE);
    expect(second).toBe(first);
  });

  it("forces upstream streaming via transport.forceStream", () => {
    expect(PROVIDERS.opencode?.forceStream).toBe(true);
  });
});
