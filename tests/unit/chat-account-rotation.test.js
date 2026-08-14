import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(), extractApiKey: vi.fn(() => null), isValidApiKey: vi.fn(),
  getProviderCredentials: vi.fn(), markAccountUnavailable: vi.fn(), clearAccountError: vi.fn(),
  getComboModels: vi.fn(), getModelInfo: vi.fn(), handleChatCore: vi.fn(), checkAndRefreshToken: vi.fn(),
  detectRequiredCapabilities: vi.fn(() => new Set()), augmentModelsWithCapacityAdapter: vi.fn(),
}));

vi.mock("@/sse/services/auth.js", () => ({ getProviderCredentials: mocks.getProviderCredentials, markAccountUnavailable: mocks.markAccountUnavailable, clearAccountError: mocks.clearAccountError, extractApiKey: mocks.extractApiKey, isValidApiKey: mocks.isValidApiKey }));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));
vi.mock("@/sse/services/model.js", () => ({ getModelInfo: mocks.getModelInfo, getComboModels: mocks.getComboModels, parseModel: () => ({ provider: "codex", model: "gpt-5" }) }));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));
vi.mock("open-sse/services/combo.js", () => ({ handleComboChat: vi.fn(), handleFusionChat: vi.fn(), detectRequiredCapabilities: mocks.detectRequiredCapabilities }));
vi.mock("open-sse/services/capacityAdapter.js", () => ({ augmentModelsWithCapacityAdapter: mocks.augmentModelsWithCapacityAdapter, withCapacityAdapterStripping: vi.fn((fn) => fn), getActiveAdapterStrategy: vi.fn() }));
vi.mock("open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: vi.fn(() => null) }));
vi.mock("@/sse/services/tokenRefresh.js", () => ({ updateProviderCredentials: vi.fn(), checkAndRefreshToken: mocks.checkAndRefreshToken }));
vi.mock("open-sse/services/projectId.js", () => ({ getProjectIdForConnection: vi.fn() }));
vi.mock("@/sse/utils/logger.js", () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn(), errorLine: vi.fn(), maskKey: vi.fn(() => "masked"), request: vi.fn() }));
vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "http://headroom.local" }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn(async () => null) }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));

const { handleChat } = await import("@/sse/handlers/chat.js");

function chatRequest() {
  return new Request("https://router.test/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "codex/gpt-5", messages: [{ role: "user", content: "hi" }] }) });
}

describe("chat account-loop rotation on synthetic 503", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });
    mocks.getComboModels.mockResolvedValue(null);
    mocks.getModelInfo.mockResolvedValue({ provider: "codex", model: "gpt-5" });
    mocks.augmentModelsWithCapacityAdapter.mockImplementation((models) => models);
    mocks.checkAndRefreshToken.mockImplementation(async (_p, creds) => creds);
    mocks.getProviderCredentials.mockResolvedValue(null);
  });

  it("selects second account after one synthetic 503, returns client 200", async () => {
    mocks.getProviderCredentials.mockResolvedValueOnce({ connectionId: "conn-a", connectionName: "Acc A", providerSpecificData: {} }).mockResolvedValueOnce({ connectionId: "conn-b", connectionName: "Acc B", providerSpecificData: {} });
    mocks.handleChatCore.mockResolvedValueOnce({ success: false, status: 503, error: "capacity", response: new Response("err", { status: 503 }) }).mockResolvedValueOnce({ success: true, response: new Response("data: ok\n\n", { status: 200 }) });
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true });

    const response = await handleChat(chatRequest());

    expect(response.status).toBe(200);
    expect(mocks.markAccountUnavailable).toHaveBeenCalledWith("conn-a", 503, expect.any(String), "codex", "gpt-5", undefined);
    expect(mocks.getProviderCredentials).toHaveBeenNthCalledWith(2, "codex", new Set(["conn-a"]), "gpt-5", { preferredConnectionId: null });
  });

  it("returns 503 only after every account is exhausted", async () => {
    mocks.getProviderCredentials.mockResolvedValueOnce({ connectionId: "conn-a", connectionName: "Acc A", providerSpecificData: {} }).mockResolvedValueOnce({ connectionId: "conn-b", connectionName: "Acc B", providerSpecificData: {} }).mockResolvedValueOnce(null);
    mocks.handleChatCore.mockResolvedValue({ success: false, status: 503, error: "capacity", response: new Response("err", { status: 503 }) });
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true });

    const response = await handleChat(chatRequest());

    expect(response.status).toBe(503);
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(3);
    expect(mocks.getProviderCredentials).toHaveBeenLastCalledWith("codex", new Set(["conn-a", "conn-b"]), "gpt-5", { preferredConnectionId: null });
  });
});