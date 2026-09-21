import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(),
  getModelInfo: vi.fn(),
  getComboModels: vi.fn(),
  handleComboChat: vi.fn(),
  handleDecisionsProxyCore: vi.fn(),
  getDecisionsConfig: vi.fn(() => ({ baseUrl: "https://openrouter.ai/api/v1/systemone" })),
  checkAndRefreshToken: vi.fn(),
  saveRequestUsage: vi.fn(),
  getComboByName: vi.fn(async () => null),
}));

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  extractApiKey: mocks.extractApiKey,
  isValidApiKey: mocks.isValidApiKey,
}));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings, getComboByName: mocks.getComboByName }));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
  getComboModels: mocks.getComboModels,
}));
vi.mock("open-sse/services/combo.js", () => ({ handleComboChat: mocks.handleComboChat }));
vi.mock("open-sse/handlers/decisionsCore.js", () => ({
  handleDecisionsProxyCore: mocks.handleDecisionsProxyCore,
  getDecisionsConfig: mocks.getDecisionsConfig,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({ checkAndRefreshToken: mocks.checkAndRefreshToken }));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: mocks.saveRequestUsage }));
vi.mock("@/sse/utils/logger.js", () => ({
  warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn(), request: vi.fn(),
}));

const { handleDecisions } = await import("@/sse/handlers/decisions.js");

const QUESTIONS = {
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
};

function decisionsRequest(model) {
  return new Request("https://router.test/v1/decisions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      state: { ticket: "My checkout page shows a blank screen after I click Pay." },
      questions: QUESTIONS,
    }),
  });
}

describe("decisions combo expansion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });
    mocks.checkAndRefreshToken.mockImplementation(async (_p, creds) => creds);
    mocks.getProviderCredentials.mockResolvedValue({
      connectionId: "conn-1", connectionName: "Acc", providerSpecificData: {},
    });
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true });
    mocks.saveRequestUsage.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("expands a combo name into members via handleComboChat (fallback/round-robin)", async () => {
    mocks.getComboModels.mockResolvedValue(["openrouter/typesafe/jev-1.13"]);
    // Combo path delegates per-member handling to handleComboChat; simulate it
    // invoking the first member like the real fallback loop does.
    mocks.handleComboChat.mockImplementation(async ({ models, handleSingleModel, body }) =>
      handleSingleModel(body, models[0]),
    );
    mocks.getModelInfo.mockResolvedValue({ provider: "openrouter", model: "typesafe/jev-1.13" });
    const answers = { is_bug: { type: "noul", noul: 0.94 } };
    mocks.handleDecisionsProxyCore.mockResolvedValue({
      success: true,
      usage: { input_tokens: 10, output_tokens: 5 },
      response: new Response(JSON.stringify({ answers }), {
        status: 200, headers: { "Content-Type": "application/json" },
      }),
    });

    const response = await handleDecisions(decisionsRequest("my-decisions-combo"));

    expect(response.status).toBe(200);
    expect(mocks.handleComboChat).toHaveBeenCalledOnce();
    expect(mocks.handleComboChat).toHaveBeenCalledWith(expect.objectContaining({
      models: ["openrouter/typesafe/jev-1.13"],
      comboName: "my-decisions-combo",
    }));
    // Per-member call strips the provider prefix before forwarding upstream.
    expect(mocks.handleDecisionsProxyCore).toHaveBeenCalledOnce();
    const coreArg = mocks.handleDecisionsProxyCore.mock.calls[0][0];
    expect(coreArg.provider).toBe("openrouter");
    expect(JSON.parse(coreArg.rawBody).model).toBe("typesafe/jev-1.13");
    expect(JSON.parse(coreArg.rawBody).questions).toEqual(QUESTIONS);
    expect(await response.json()).toEqual({ answers });
  });

  it("combo with no decisions members fails fast without touching upstream", async () => {
    mocks.getComboModels.mockResolvedValue(["openrouter/gpt-4o-mini"]);
    mocks.getComboByName.mockResolvedValue({ name: "chat-only-combo", models: ["openrouter/gpt-4o-mini"] });

    const response = await handleDecisions(decisionsRequest("chat-only-combo"));

    expect(response.status).toBe(400);
    expect(mocks.handleComboChat).not.toHaveBeenCalled();
    expect(mocks.handleDecisionsProxyCore).not.toHaveBeenCalled();
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({
      error: expect.objectContaining({
        message: "Combo 'chat-only-combo' has no decisions-capable members",
      }),
    });
  });

  it("single (non-combo) model still goes straight to the proxy core", async () => {
    mocks.getComboModels.mockResolvedValue(null);
    mocks.getModelInfo.mockResolvedValue({ provider: "openrouter", model: "typesafe/jev-1.13" });
    mocks.handleDecisionsProxyCore.mockResolvedValue({
      success: true,
      usage: { input_tokens: 10, output_tokens: 5 },
      response: new Response(JSON.stringify({ answers: {} }), {
        status: 200, headers: { "Content-Type": "application/json" },
      }),
    });

    const response = await handleDecisions(decisionsRequest("openrouter/typesafe/jev-1.13"));

    expect(response.status).toBe(200);
    expect(mocks.handleComboChat).not.toHaveBeenCalled();
    expect(mocks.handleDecisionsProxyCore).toHaveBeenCalledOnce();
  });
});
