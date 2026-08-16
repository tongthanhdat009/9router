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
async function mockWs(onOpen) {
  const server = http.createServer();
  server.on("upgrade", (request, socket) => {
    const accept = crypto.createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.push(socket);
    onOpen(socket, request);
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
    await expect(pending).rejects.toMatchObject({ name: "WsStreamError", framesEmitted: 0 });
  });

  it("uses upstream URL and settings default", () => {
    expect(wsUrl("https://chatgpt.com/backend-api/codex/responses")).toBe("wss://chatgpt.com/backend-api/codex/responses");
    expect(mergeWithDefaults({}).codexUpstreamWebsocket).toBe(false);
    expect(mergeWithDefaults({ codexUpstreamWebsocket: true }).codexUpstreamWebsocket).toBe(true);
  });
});
