import { closeSocket, connectCodexResponsesWs, WsConnectError, WsStreamError } from "./codexWsClient.js";

const encoder = new TextEncoder();
const TERMINAL_TYPES = new Set(["response.completed", "response.failed", "response.incomplete"]);
const IDLE_MS = 10 * 60 * 1000;
const FIRST_FRAME_TIMEOUT_MS = 15000;
const cache = new Map();
const connecting = new Map();

function sseFrame(event) { return encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); }
function connectionKey(credentials) { return credentials?.connectionId || null; }
function wsUrl(url) { return url.replace(/^http:/, "ws:").replace(/^https:/, "wss:"); }
function waitForSlot(entry) { const previous = entry.tail; let release; entry.tail = new Promise(resolve => { release = resolve; }); return previous.then(() => release); }
function drop(key, entry) { if (key && cache.get(key) === entry) cache.delete(key); closeSocket(entry.socket); }
function evictIdle() { const now = Date.now(); for (const [key, entry] of cache) if (!entry.busy && now - entry.lastUsed > IDLE_MS) drop(key, entry); }

async function getConnection({ key, url, headers, signal, timeoutMs }) {
  evictIdle();
  const cached = key ? cache.get(key) : null;
  if (cached && cached.socket.readyState === WebSocket.OPEN) return cached;
  if (!key) {
    const socket = await connectCodexResponsesWs({ url, headers, signal, timeoutMs });
    return { socket, tail: Promise.resolve(), busy: false, lastUsed: Date.now() };
  }
  let pending = connecting.get(key);
  if (!pending) {
    // ponytail: shared connect rides the first caller's abort signal; later waiters reuse it.
    pending = connectCodexResponsesWs({ url, headers, signal, timeoutMs }).then(socket => {
      const entry = { socket, tail: Promise.resolve(), busy: false, lastUsed: Date.now() };
      cache.set(key, entry);
      return entry;
    }).finally(() => connecting.delete(key));
    connecting.set(key, pending);
  }
  return pending;
}

export async function executeCodexWs({ url, headers, transformedBody, credentials, signal, timeoutMs }) {
  if (signal?.aborted) throw signal.reason || new DOMException("Aborted", "AbortError");
  const target = wsUrl(url);
  const key = connectionKey(credentials);
  let entry = await getConnection({ key, url: target, headers, signal, timeoutMs });
  let retriedLimit = false;
  while (true) {
    const release = await waitForSlot(entry);
    entry.busy = true;
    const releaseNow = () => { entry.busy = false; entry.lastUsed = Date.now(); release(); };
    if (signal?.aborted) { releaseNow(); throw signal.reason || new DOMException("Aborted", "AbortError"); }
    if (entry.socket.readyState !== WebSocket.OPEN) {
      // Socket closed while queued — reconnect, then re-acquire the fresh slot.
      releaseNow(); drop(key, entry);
      entry = await getConnection({ key, url: target, headers, signal, timeoutMs });
      continue;
    }
    try {
      // Slot ownership transfers into the stream: released only on terminal
      // event, failure, body cancel, or pre-output rejection — never on return.
      return await streamRequest({ entry, transformedBody, signal, timeoutMs, release });
    } catch (error) {
      if (error?.code === "websocket_connection_limit_reached" && !retriedLimit && error.framesEmitted === 0) {
        // Explicit upstream limit: one fresh connection, never parallel sockets per account.
        retriedLimit = true; drop(key, entry); entry = await getConnection({ key, url: target, headers, signal, timeoutMs }); continue;
      }
      throw error;
    }
  }
}

async function streamRequest({ entry, transformedBody, signal, timeoutMs, release }) {
  const socket = entry.socket;
  const firstFrameMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : FIRST_FRAME_TIMEOUT_MS;
  let framesEmitted = 0;
  let settled = false;
  let controller;
  let readyResolve;
  let readyReject;
  let timer = null;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  let released = false;
  const releaseSlot = () => {
    if (released) return; released = true;
    clearTimeout(timer);
    entry.busy = false; entry.lastUsed = Date.now(); release();
  };
  const fail = (error) => {
    if (settled) return; settled = true;
    releaseSlot(); closeSocket(socket);
    // Keep AbortError name intact: CodexExecutor must rethrow it, never fall back to HTTP.
    const wrapped = error instanceof WsStreamError || error?.name === "AbortError" ? error : new WsStreamError(error?.message || "WebSocket stream failed", framesEmitted, error);
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
          if (framesEmitted === 1) { clearTimeout(timer); readyResolve(); }
          if (TERMINAL_TYPES.has(event.type)) {
            settled = true; releaseSlot(); c.close();
            // Healthy socket stays open so the next queued request can reuse it.
            socket.onmessage = null; socket.onerror = null;
          }
        } catch (error) { fail(error); }
      };
      socket.onerror = event => fail(event?.error || new Error("WebSocket stream error"));
      socket.onclose = event => { if (!settled) fail(new Error(`WebSocket closed (${event.code || 0})`)); };
      signal?.addEventListener("abort", () => fail(signal.reason || new DOMException("Aborted", "AbortError")), { once: true });
      try {
        socket.send(JSON.stringify({ type: "response.create", ...transformedBody, client_metadata: transformedBody.client_metadata }));
      } catch (error) { fail(error); return; }
      timer = setTimeout(() => fail(new WsStreamError(`WebSocket first frame timeout (${firstFrameMs}ms)`, 0)), firstFrameMs);
    },
    cancel(reason) { releaseSlot(); closeSocket(socket); fail(reason instanceof Error ? reason : new Error("WebSocket stream cancelled")); },
  });
  const response = new Response(stream, { headers: { "content-type": "text/event-stream" } });
  await ready;
  return response;
}

export { WsConnectError, WsStreamError, wsUrl };
