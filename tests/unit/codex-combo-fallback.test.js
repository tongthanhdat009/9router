import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

import { handleComboChat } from "../../open-sse/services/combo.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";
import { CodexExecutor } from "../../open-sse/executors/codex.js";

const log = { info: vi.fn(), warn: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  fetchMock.mockReset();
});

function transientResponse(errorCode) {
  return new Response(JSON.stringify({ error: { message: errorCode } }), {
    status: 503,
  });
}

function sseTransientResponse(errorCode) {
  return new Response(
    [
      "event: error",
      `data: {\"error\":{\"message\":\"${errorCode}\"}}`,
      "",
    ].join("\n"),
    {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    },
  );
}

describe("Codex SSE transient combo fallback", () => {
  it.each(["server_is_overloaded", "service_unavailable_error"])(
    "continues combo after Codex exhausts its 3 SSE retries: %s",
    async (errorCode) => {
      fetchMock.mockImplementation(() => sseTransientResponse(errorCode));
      const executor = new CodexExecutor();
      executor.config.retry = {
        ...executor.config.retry,
        503: { attempts: 3, delayMs: 0 },
      };

      const firstResult = await executor.execute({
        model: "gpt-5.5-codex",
        body: { model: "gpt-5.5-codex", input: "hi" },
        stream: true,
        credentials: { accessToken: "token", connectionId: "codex-1" },
        log,
      });

      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(firstResult.response.status).toBe(503);
      const exhaustedResponse = firstResult.response.clone();
      expect(await firstResult.response.json()).toMatchObject({
        error: { message: errorCode },
      });

      const nextModel = new Response("ok", { status: 200 });
      const tried = [];
      const response = await handleComboChat({
        body: {},
        models: ["codex/gpt-5.5-codex", "openai/gpt-4.1"],
        handleSingleModel: vi.fn(async (_, model) => {
          tried.push(model);
          return model.startsWith("codex/") ? exhaustedResponse : nextModel;
        }),
        log,
      });

      expect(tried).toEqual(["codex/gpt-5.5-codex", "openai/gpt-4.1"]);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("ok");
    },
  );

  it.each(["server_is_overloaded", "service_unavailable_error"])(
    "tries next configured model after exhausted retries: %s",
    async (errorCode) => {
      const classified = checkFallbackError(503, errorCode);
      expect(classified.shouldFallback).toBe(true);
      expect(classified.cooldownMs).toBeGreaterThan(0);

      const tried = [];
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const handleSingleModel = vi.fn(async (_, model) => {
        tried.push(model);
        return model.startsWith("codex/")
          ? transientResponse(errorCode)
          : new Response("ok", { status: 200 });
      });

      const response = await handleComboChat({
        body: {},
        models: ["codex/gpt-5.5-codex", "openai/gpt-4.1"],
        handleSingleModel,
        log,
      });

      expect(tried).toEqual(["codex/gpt-5.5-codex", "openai/gpt-4.1"]);
      expect(handleSingleModel).toHaveBeenCalledTimes(2);
      expect(setTimeoutSpy).not.toHaveBeenCalled();
      setTimeoutSpy.mockRestore();
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("ok");
    },
  );
});
