import { closeSocket, connectCodexResponsesWs, WsConnectError, WsStreamError } from "./codexWsClient.js";

const encoder = new TextEncoder();
const TERMINAL_TYPES = new Set(["response.completed", "response.failed", "response.incomplete"]);
const IDLE_MS = 10 * 60 * 1000;
const cache = new Map();

function sseFrame(event) { return encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); }
function connectionKey(credentials) { return credentials?.connectionId || null; }
function wsUrl(url) { return url.replace(/^http:/, "ws:").replace(/^https:/, "wss:"); }
function waitForSlot(entry) { const previous = entry.tail; let release; entry.tail = new Promise(resolve => { release = resolve; }); return previous.then(() => release); }
function drop(key, entry) { if (cache.get(key) === entry) cache.delete(key); closeSocket(entry.socket); }
function evictIdle() { const now = Date.now(); for (const [key, entry] of cache) if (!entry.busy && now - entry.lastUsed > IDLE_MS) drop(key, entry); }

async function getConnection({ key, url, headers, signal, timeoutMs }) {
  evictIdle();
  let entry = key ? cache.get(key) : null;
  if (!entry || entry.socket.readyState !== WebSocket.OPEN) {
    const socket = await connectCodexResponsesWs({ url, headers, signal, timeoutMs });
    entry = { socket, tail: Promise.resolve(), busy: false, lastUsed: Date.now() };
    if (key) cache.set(key, entry);
  }
  return entry;
}

export async function executeCodexWs({ url, headers, transformedBody, credentials, signal, timeoutMs }) {
  const target = wsUrl(url);
  const key = connectionKey(credentials);
  let entry = await getConnection({ key, url: target, headers, signal, timeoutMs });
  let retriedLimit = false;
  while (true) {
    const release = await waitForSlot(entry);
    entry.busy = true;
    try {
      return await streamRequest({ entry, transformedBody, signal, key, url: target, headers, timeoutMs, retryLimit: !retriedLimit });
    } catch (error) {
      if (error?.code === "websocket_connection_limit_reached" && !retriedLimit) {
        retriedLimit = true; drop(key, entry); entry = await getConnection({ key, url: target, headers, signal, timeoutMs }); continue;
      }
      throw error;
    } finally { entry.busy = false; entry.lastUsed = Date.now(); release(); }
  }
}

async function streamRequest({ entry, transformedBody, signal }) {
  const socket = entry.socket;
  let framesEmitted = 0;
  let settled = false;
  let controller;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const fail = (error) => {
    if (settled) return; settled = true; closeSocket(socket);
    const wrapped = error instanceof WsStreamError ? error : new WsStreamError(error?.message || "WebSocket stream failed", framesEmitted, error);
    controller?.error(wrapped);
    if (framesEmitted === 0) readyReject(wrapped);
  };
  const stream = new ReadableStream({
    start(c) {
      controller = c;
      socket.onmessage = ({ data }) => {
        try {
          const event = JSON.parse(typeof data === "string" ? data : String(data));
          if (event?.code === "websocket_connection_limit_reached") { const error = new WsStreamError("WebSocket connection limit reached", framesEmitted); error.code = event.code; return fail(error); }
          if (!event || typeof event.type !== "string") return;
          framesEmitted++; c.enqueue(sseFrame(event));
          if (framesEmitted === 1) readyResolve();
          if (TERMINAL_TYPES.has(event.type)) { settled = true; c.close(); closeSocket(socket); }
        } catch (error) { fail(error); }
      };
      socket.onerror = event => fail(event?.error || new Error("WebSocket stream error"));
      socket.onclose = event => { if (!settled) fail(new Error(`WebSocket closed (${event.code || 0})`)); };
      signal?.addEventListener("abort", () => fail(signal.reason || new DOMException("Aborted", "AbortError")), { once: true });
      try { socket.send(JSON.stringify({ type: "response.create", ...transformedBody, client_metadata: transformedBody.client_metadata })); } catch (error) { fail(error); }
    },
    cancel(reason) { closeSocket(socket); fail(reason instanceof Error ? reason : new Error("WebSocket stream cancelled")); },
  });
  const response = new Response(stream, { headers: { "content-type": "text/event-stream" } });
  await ready;
  return response;
}

export { WsConnectError, WsStreamError, wsUrl };
