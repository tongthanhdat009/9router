import crypto from "node:crypto";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { executeCodexWs, WsConnectError, WsStreamError, wsUrl } from "../../open-sse/executors/codexWsTransport.js";
import { mergeWithDefaults } from "../../src/lib/db/repos/settingsRepo.js";

const servers = [];
const sockets = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function frame(json) {
  const payload = Buffer.from(JSON.stringify(json));
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}
function demask(raw) {
  // RFC6455: client->server frames are masked; unmask small frames for inspection.
  const len = raw[1] & 0x7f;
  const offset = len < 126 ? 2 : 4;
  const mask = raw.subarray(offset, offset + 4);
  const payload = raw.subarray(offset + 4);
  return Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4])).toString("utf8");
}
async function mockWs(onOpen, delayMs = 0) {
  const server = http.createServer();
  server.on("upgrade", (request, socket) => {
    const accept = crypto.createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    sockets.push(socket);
    setTimeout(() => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      onOpen(socket, request);
    }, delayMs);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}/responses`;
}
afterEach(async () => { for (const socket of sockets.splice(0)) socket.destroy(); const closing = servers.splice(0); await Promise.all(closing.map(server => new Promise(resolve => server.close(resolve)))); });

const input = url => ({ url, headers: { Authorization: "Bearer token" }, transformedBody: { model: "gpt", input: "hi" }, credentials: { connectionId: crypto.randomUUID() }, timeoutMs: 1000 });

describe("Codex upstream WebSocket transport", () => {
  it("sends required authentication and session headers during handshake", async () => {
    const headers = { Authorization: "Bearer token", "OpenAI-Beta": "responses=experimental", "session-id": "session", "thread-id": "thread", "x-client-request-id": "request" };
    let receivedHeaders;
    const url = await mockWs((socket, request) => { receivedHeaders = request.headers; socket.destroy(); });
    await expect(executeCodexWs({ ...input(url), headers })).rejects.toMatchObject({ name: "WsStreamError", framesEmitted: 0 });
    expect(receivedHeaders).toMatchObject(Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])));
  });

  it("converts JSON WebSocket event to exact SSE then closes terminal stream", async () => {
    const url = await mockWs(socket => setTimeout(() => { socket.write(frame({ type: "response.output_text.delta", delta: "ok" })); socket.write(frame({ type: "response.completed" })); setTimeout(() => socket.destroy(), 10); }, 10));
    const response = await executeCodexWs(input(url));
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\nevent: response.completed\ndata: {"type":"response.completed"}\n\n');
  });

  it("classifies connection failure and pre-output close", async () => {
    await expect(executeCodexWs(input("http://127.0.0.1:1/responses"))).rejects.toBeInstanceOf(WsConnectError);
    const url = await mockWs(socket => setTimeout(() => socket.destroy(), 10));
    await expect(executeCodexWs(input(url))).rejects.toMatchObject({ name: "WsStreamError", framesEmitted: 0 });
  });

  it("surfaces post-output failure without replay", async () => {
    const url = await mockWs(socket => setTimeout(() => { socket.write(frame({ type: "response.output_text.delta", delta: "ok" })); setTimeout(() => socket.destroy(), 10); }, 10));
    const response = await executeCodexWs(input(url));
    await expect(response.text()).rejects.toMatchObject({ name: "WsStreamError", framesEmitted: 1 });
  });

  it("aborts socket", async () => {
    const url = await mockWs(() => {});
    const controller = new AbortController();
    const pending = executeCodexWs({ ...input(url), signal: controller.signal });
    await sleep(20); controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects already-aborted signal before send", async () => {
    const url = await mockWs(() => {});
    const controller = new AbortController(); controller.abort();
    await expect(executeCodexWs({ ...input(url), signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("keeps AbortError name when aborted mid-stream", async () => {
    const url = await mockWs(socket => setTimeout(() => socket.write(frame({ type: "response.output_text.delta", delta: "ok" })), 10));
    const controller = new AbortController();
    const response = await executeCodexWs({ ...input(url), signal: controller.signal });
    await sleep(20); controller.abort();
    await expect(response.text()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("times out when no first frame arrives", async () => {
    const url = await mockWs(() => {});
    await expect(executeCodexWs({ ...input(url), timeoutMs: 50 })).rejects.toMatchObject({ name: "WsStreamError", framesEmitted: 0, message: expect.stringContaining("first frame timeout") });
  });

  it("serializes concurrent same-account requests without cross-contamination and reuses the socket", async () => {
    const seen = [];
    let upgrades = 0;
    const url = await mockWs((socket, request) => {
      upgrades++;
      socket.on("data", raw => {
        let text;
        try { text = demask(raw); } catch { return; }
        const marker = /"marker":"([^"]+)"/.exec(text);
        if (!marker) return;
        seen.push(marker[1]);
        const id = marker[1];
        socket.write(frame({ type: "response.output_text.delta", delta: id }));
        socket.write(frame({ type: "response.completed" }));
      });
    });
    const credentials = { connectionId: "shared-account" };
    const run = marker => executeCodexWs({ ...input(url), credentials, transformedBody: { model: "gpt", input: "hi", marker } });
    const [a, b] = await Promise.all([run("A"), run("B")]);
    const textA = await a.text();
    const textB = await b.text();
    expect(upgrades).toBe(1);
    expect(seen.sort()).toEqual(["A", "B"]);
    expect(textA).toContain('"delta":"A"');
    expect(textA).not.toContain('"delta":"B"');
    expect(textB).toContain('"delta":"B"');
    expect(textB).not.toContain('"delta":"A"');
  });

  it("first caller aborting a shared connect does not break later same-account waiters", async () => {
    let upgrades = 0;
    let releaseHandshake;
    const handshakeGate = new Promise(resolve => { releaseHandshake = resolve; });
    let markUpgradeSeen;
    const upgradeSeen = new Promise(resolve => { markUpgradeSeen = resolve; });
    const server = http.createServer();
    server.on("upgrade", (request, socket) => {
      const accept = crypto.createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      sockets.push(socket);
      upgrades++;
      markUpgradeSeen();
      // Hold the HTTP 101 until the test has aborted the first caller mid-handshake.
      handshakeGate.then(() => {
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        socket.on("data", raw => {
          let text;
          try { text = demask(raw); } catch { return; }
          const marker = /"marker":"([^"]+)"/.exec(text);
          if (!marker) return;
          socket.write(frame({ type: "response.output_text.delta", delta: marker[1] }));
          socket.write(frame({ type: "response.completed" }));
        });
      });
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const url = `http://127.0.0.1:${server.address().port}/responses`;
    const credentials = { connectionId: "shared-abort-account" };
    const controllerA = new AbortController();
    // A starts the shared dial; the gate keeps the handshake unresolved.
    const a = executeCodexWs({ ...input(url), credentials, transformedBody: { model: "gpt", input: "hi", marker: "A" }, signal: controllerA.signal });
    await upgradeSeen;
    // B joins the same pending connect while A's handshake is still gated.
    const b = executeCodexWs({ ...input(url), credentials, transformedBody: { model: "gpt", input: "hi", marker: "B" } });
    controllerA.abort();
    await expect(a).rejects.toMatchObject({ name: "AbortError" });
    releaseHandshake();
    const response = await b;
    expect(await response.text()).toContain('"delta":"B"');
    expect(upgrades).toBe(1);
  });

  it("uses upstream URL and settings default", () => {
    expect(wsUrl("https://chatgpt.com/backend-api/codex/responses")).toBe("wss://chatgpt.com/backend-api/codex/responses");
    expect(mergeWithDefaults({}).codexUpstreamWebsocket).toBe(false);
    expect(mergeWithDefaults({ codexUpstreamWebsocket: true }).codexUpstreamWebsocket).toBe(true);
  });
});
