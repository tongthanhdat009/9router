import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleComboChat } from "../../open-sse/services/combo.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

const log = { info: vi.fn(), warn: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function transientResponse(errorCode) {
  return new Response(JSON.stringify({ error: { message: errorCode } }), {
    status: 503,
  });
}

describe("Codex SSE transient combo fallback", () => {
  it.each(["server_is_overloaded", "service_unavailable_error"])(
    "rotates to next model when Codex returns 503 for SSE transient: %s",
    async (errorCode) => {
      const nextModel = new Response("ok", { status: 200 });
      const tried = [];
      const response = await handleComboChat({
        body: {},
        models: ["codex/gpt-5.5-codex", "openai/gpt-4.1"],
        handleSingleModel: vi.fn(async (_, model) => {
          tried.push(model);
          return model.startsWith("codex/") ? transientResponse(errorCode) : nextModel;
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
