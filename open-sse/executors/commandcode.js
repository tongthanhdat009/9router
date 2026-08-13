import { randomUUID } from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { commandCodeToOpenAIResponse } from "../translator/response/commandcode-to-openai.js";
import { SSE_DONE } from "../utils/sseConstants.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";

/**
 * CommandCodeExecutor — talks to https://api.commandcode.ai/alpha/generate
 *
 * Auth: Bearer <user_xxx> API key (stored as the connection's apiKey).
 * Adds the per-request `x-session-id` header expected by CommandCode upstream.
 *
 * Upstream returns AI SDK v5 NDJSON (one JSON event per line, no `data:` prefix).
 * We translate each event to an OpenAI chat.completion.chunk and emit it as SSE so
 * both the streaming and non-streaming (forced SSE → JSON) downstream handlers in
 * 9router can consume it without further format translation.
 */
export class CommandCodeExecutor extends BaseExecutor {
  constructor() {
    super("commandcode", PROVIDERS.commandcode);
  }

  transformRequest(model, body, stream, credentials) {
    body.stream = true;
    return body;
  }

  buildHeaders(credentials, stream = true) {
    const headers = {
      "Content-Type": "application/json",
      ...(this.config.headers || {}),
      "x-session-id": randomUUID(),
    };

    const token = credentials?.apiKey || credentials?.accessToken;
    if (token) headers["Authorization"] = `Bearer ${token}`;

    if (stream) headers["Accept"] = "text/event-stream";
    return headers;
  }

  async execute(opts) {
    const result = await super.execute(opts);
    if (!result?.response?.ok || !result.response.body) return result;
    const preflight = await peekNdjsonError(result.response);
    if (preflight.errorMessage) {
      try { await result.response.body.cancel(); } catch { /* noop */ }
      result.response = new Response(JSON.stringify({
        error: {
          message: preflight.errorMessage,
          type: "server_error",
          code: "upstream_error",
        }
      }), {
        status: HTTP_STATUS.SERVICE_UNAVAILABLE,
        headers: { "Content-Type": "application/json" },
      });
      return result;
    }
    result.response = wrapNdjsonAsOpenAISse(preflight.replayResponse, opts.model);
    return result;
  }
}

// Bounded preflight: read just enough NDJSON to detect a pre-output `{type:"error"}`
// line before any user-visible content. On error, return its message so execute()
// swaps in a synthetic 503 (chatCore/chat account loop then rotates the connection).
// On success, return a fresh Response whose body replays the exact buffered bytes
// followed by the remaining upstream tail. Errors after a text-delta/reasoning-delta/
// tool line stay in-stream: headers are already committed downstream, so rotation
// would be unsafe.
const COMMANDCODE_PREFLIGHT_BYTES = 8 * 1024;

function peekNdjsonError(originalResponse) {
  const reader = originalResponse.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let text = "";
  let scannedBytes = 0;

  return (async () => {
    try {
      while (scannedBytes < COMMANDCODE_PREFLIGHT_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        scannedBytes += value.byteLength;
        text += decoder.decode(value, { stream: true });
        const lines = text.split("\n");
        text = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let event;
          try {
            event = JSON.parse(trimmed);
          } catch {
            continue;
          }
          if (!event || typeof event !== "object") continue;
          if (event.type === "error") {
            const errVal = event.error ?? event.message ?? "unknown";
            const errStr = typeof errVal === "string" ? errVal : JSON.stringify(errVal);
            try { await reader.cancel(); } catch { /* noop */ }
            try { reader.releaseLock(); } catch { /* noop */ }
            return { errorMessage: `Command Code upstream error: ${errStr}`, replayResponse: null };
          }
          // Any user-visible output starts the commit point — stop preflighting and
          // replay buffered bytes verbatim ahead of the still-readable upstream tail.
          if (
            event.type === "text-delta" ||
            event.type === "reasoning-delta" ||
            event.type === "tool-input-start" ||
            event.type === "tool-input-delta" ||
            event.type === "tool-call"
          ) {
            return { errorMessage: null, replayResponse: replayResponse(originalResponse, reader, chunks) };
          }
        }
      }
    } catch (error) {
      // Stream read failed after buffering bytes — propagate the failure through the
      // replay stream (controller.error after enqueuing buffered chunks) rather than
      // discarding them and returning an empty 200.
      try { await reader.cancel(); } catch { /* noop */ }
      try { reader.releaseLock(); } catch { /* noop */ }
      return { errorMessage: null, replayResponse: replayResponse(originalResponse, null, chunks, error) };
    }

    // Check the trailing partial line left in the buffer (no final newline).
    const trailing = text.trim();
    if (trailing) {
      try {
        const event = JSON.parse(trailing);
        if (event && typeof event === "object" && event.type === "error") {
          const errVal = event.error ?? event.message ?? "unknown";
          const errStr = typeof errVal === "string" ? errVal : JSON.stringify(errVal);
          try { await reader.cancel(); } catch { /* noop */ }
          try { reader.releaseLock(); } catch { /* noop */ }
          return { errorMessage: `Command Code upstream error: ${errStr}`, replayResponse: null };
        }
      } catch { /* not JSON — leave in buffer */ }
    }

    // Reached the preflight byte cap with no error/output: replay every buffered
    // raw chunk (the partial trailing line is already inside the last chunk).
    return { errorMessage: null, replayResponse: replayResponse(originalResponse, reader, chunks) };
  })();
}

// Build a Response whose body emits the preflight-buffered raw chunks first, then
// streams the rest of the upstream body. `readError` preserves an upstream failure
// instead of turning it into an empty successful stream.
function replayResponse(originalResponse, reader, chunks, readError = null) {
  let pendingError = readError;
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
    },
    async pull(controller) {
      if (pendingError) {
        const error = pendingError;
        pendingError = null;
        controller.error(error);
        return;
      }
      if (!reader) { controller.close(); return; }
      try {
        const { done, value } = await reader.read();
        if (done) { controller.close(); return; }
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader?.cancel(reason);
    },
  });
  return new Response(body, {
    status: originalResponse.status,
    statusText: originalResponse.statusText,
    headers: originalResponse.headers,
  });
}

function wrapNdjsonAsOpenAISse(originalResponse, model) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const state = { model };

  const emitChunks = (chunks, controller) => {
    if (!chunks) return;
    const list = Array.isArray(chunks) ? chunks : [chunks];
    for (const c of list) {
      if (c == null) continue;
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(c)}\n\n`));
    }
  };

  const transform = new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // Translate AI SDK v5 NDJSON line to one or more OpenAI chunks
        emitChunks(commandCodeToOpenAIResponse(trimmed, state), controller);
      }
    },
    flush(controller) {
      const trimmed = buffer.trim();
      if (trimmed) {
        emitChunks(commandCodeToOpenAIResponse(trimmed, state), controller);
      }
      controller.enqueue(encoder.encode(SSE_DONE));
    },
  });

  const newBody = originalResponse.body.pipeThrough(transform);
  return new Response(newBody, {
    status: originalResponse.status,
    statusText: originalResponse.statusText,
    headers: originalResponse.headers,
  });
}

export default CommandCodeExecutor;
