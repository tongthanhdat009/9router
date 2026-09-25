/**
 * Unit tests for the OpenRouter decisions (TypeSafe Jev) wiring.
 *
 * Covers:
 *  - registry wiring (decisionsConfig, decisions serviceKind, jev-1.13 model)
 *  - decisionsCore: verbatim pass-through to SystemOne, auth + attribution headers
 *  - decisionsCore: unknown provider rejected, upstream errors surfaced
 *
 * Docs: https://openrouter.ai/docs/guides/community/typesafe-sdk
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const proxyMocks = vi.hoisted(() => ({
  proxyAwareFetch: vi.fn(),
}));

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: proxyMocks.proxyAwareFetch,
}));

vi.mock("open-sse/services/tokenRefresh.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, refreshTokenByProvider: vi.fn() };
});

import { handleDecisionsProxyCore, getDecisionsConfig } from "open-sse/handlers/decisionsCore.js";
import { PROVIDER_MEDIA, PROVIDER_MODELS } from "open-sse/providers/index.js";

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const DECISIONS_BODY = {
  model: "typesafe/jev-1.13",
  state: { ticket: "My checkout page shows a blank screen after I click Pay." },
  questions: {
    is_bug: { type: "noul", instructions: "Is the customer reporting a software defect?" },
    team: {
      type: "choice",
      instructions: "Which team should own this ticket?",
      criteria: { payments: "Checkout issues.", frontend: "Rendering issues." },
    },
    urgency: {
      type: "score",
      instructions: "How urgent is this ticket?",
      criteria: ["Can wait", "Blocking revenue"],
    },
  },
};

const DECISIONS_OK = {
  id: "gen-dec-1",
  model: "typesafe/jev-1.13-20260917",
  provider: "TypeSafe",
  answers: {
    is_bug: { type: "noul", noul: 0.96 },
    team: { type: "choice", choice: "payments", confidence: 0.75 },
    urgency: { type: "score", score: 1.99, confidence: 0.99 },
  },
  usage: { input_tokens: 476, output_tokens: 70 },
};

describe("registry wiring", () => {
  it("exposes decisionsConfig + decisions serviceKind for openrouter", () => {
    expect(getDecisionsConfig("openrouter").baseUrl).toBe("https://openrouter.ai/api/v1/systemone");
    expect(PROVIDER_MEDIA.openrouter.serviceKinds).toContain("decisions");
  });

  it("registers the jev decisions model (not chat)", () => {
    const jev = PROVIDER_MODELS.openrouter.find((m) => m.id === "typesafe/jev-1.13");
    expect(jev?.kind).toBe("decisions");
  });

  it("has no decisionsConfig for chat-only providers", () => {
    expect(getDecisionsConfig("anthropic")).toBeNull();
  });

  it("exposes zen SystemOne decisionsConfig + decisions kind for opencode", () => {
    expect(getDecisionsConfig("opencode")?.baseUrl).toBe("https://opencode.ai/zen/v1/systemone");
    expect(PROVIDER_MEDIA.opencode.serviceKinds).toContain("decisions");
    // Registry alias is "oc" so PROVIDER_MODELS is keyed by alias, not id.
    for (const id of ["jev-1.13", "jev-1.13-free"]) {
      expect(PROVIDER_MODELS.oc.find((m) => m.id === id)?.kind).toBe("decisions");
    }
  });
});

describe("decisionsCore proxy", () => {
  beforeEach(() => {
    proxyMocks.proxyAwareFetch.mockReset();
  });

  it("POSTs the body verbatim to SystemOne with auth + attribution headers", async () => {
    proxyMocks.proxyAwareFetch.mockResolvedValueOnce(jsonResponse(DECISIONS_OK));

    const raw = JSON.stringify(DECISIONS_BODY);
    const result = await handleDecisionsProxyCore({
      provider: "openrouter",
      rawBody: raw,
      credentials: { apiKey: "sk-or-key" },
    });

    expect(result.success).toBe(true);
    const [url, init] = proxyMocks.proxyAwareFetch.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/systemone");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(raw); // verbatim — noul/choice/score must not be reshaped
    expect(init.headers.Authorization).toBe("Bearer sk-or-key");
    expect(init.headers["HTTP-Referer"]).toBe("https://endpoint-proxy.local");
    expect(result.usage).toEqual(DECISIONS_OK.usage);
    expect(await result.response.json()).toEqual(DECISIONS_OK);
  });

  it("rejects providers without decisionsConfig", async () => {
    const result = await handleDecisionsProxyCore({
      provider: "anthropic",
      rawBody: JSON.stringify(DECISIONS_BODY),
      credentials: { apiKey: "sk-ant" },
    });
    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(proxyMocks.proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("surfaces upstream errors with status", async () => {
    proxyMocks.proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({ error: { message: "typesafe/jev-1.13 is a decisions model", code: 400 } }, 400),
    );
    const result = await handleDecisionsProxyCore({
      provider: "openrouter",
      rawBody: JSON.stringify(DECISIONS_BODY),
      credentials: { apiKey: "sk-or-key" },
    });
    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
  });

  it("routes noauth Jev through the exact per-connection proxy options", async () => {
    proxyMocks.proxyAwareFetch.mockResolvedValueOnce(jsonResponse(DECISIONS_OK));
    const raw = JSON.stringify({ ...DECISIONS_BODY, model: "jev-1.13-free" });
    const proxyOptions = {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.test:8080",
      connectionNoProxy: "localhost,127.0.0.1",
      vercelRelayUrl: "",
    };

    const result = await handleDecisionsProxyCore({
      provider: "opencode",
      rawBody: raw,
      credentials: { connectionId: "noauth", id: "noauth", accessToken: "public" },
      proxyOptions,
    });

    expect(result.success).toBe(true);
    expect(proxyMocks.proxyAwareFetch).toHaveBeenCalledOnce();
    const [url, init, receivedProxyOptions] = proxyMocks.proxyAwareFetch.mock.calls[0];
    expect(url).toBe("https://opencode.ai/zen/v1/systemone");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(raw);
    expect(init.headers.Authorization).toBe("Bearer public");
    expect(init.headers["x-opencode-client"]).toBe("desktop");
    expect(receivedProxyOptions).toBe(proxyOptions);
  });
});
