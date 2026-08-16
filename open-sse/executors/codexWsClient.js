const CLOSE_NORMAL = 1000;

export class WsConnectError extends Error {
  constructor(message, cause = null) { super(message); this.name = "WsConnectError"; this.cause = cause; }
}

export class WsStreamError extends Error {
  constructor(message, framesEmitted = 0, cause = null) { super(message); this.name = "WsStreamError"; this.framesEmitted = framesEmitted; this.cause = cause; }
}

function wsError(event) {
  return event?.error || new Error(event?.message || "WebSocket error");
}

export async function connectCodexResponsesWs({ url, headers, signal, timeoutMs = 15000 }) {
  if (typeof WebSocket !== "function") throw new WsConnectError("WebSocket unavailable");
  if (signal?.aborted) throw signal.reason || new DOMException("Aborted", "AbortError");
  let socket;
  let timer;
  let abort;
  try {
    socket = new WebSocket(url, [], { headers });
    await new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      timer = setTimeout(() => { closeSocket(socket); cleanup(); reject(new WsConnectError("WebSocket connect timeout")); }, timeoutMs);
      abort = () => { closeSocket(socket); cleanup(); reject(signal.reason || new DOMException("Aborted", "AbortError")); };
      socket.onopen = () => { cleanup(); resolve(); };
      socket.onerror = (event) => { cleanup(); reject(new WsConnectError("WebSocket connect failed", wsError(event))); };
      socket.onclose = (event) => { cleanup(); reject(new WsConnectError(`WebSocket closed during connect (${event.code || 0})`)); };
      signal?.addEventListener("abort", abort, { once: true });
    });
  } catch (error) {
    closeSocket(socket);
    if (error?.name === "AbortError") throw error;
    throw error instanceof WsConnectError ? error : new WsConnectError("WebSocket connect failed", error);
  }
  return socket;
}

export function closeSocket(socket) {
  if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) return;
  try { socket.close(CLOSE_NORMAL); } catch { /* noop */ }
}
