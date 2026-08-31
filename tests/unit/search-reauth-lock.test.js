import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression: a search-capable provider's token-refresh failure (_needsReauth)
// must lock ONLY the search capability (modelLock_websearch:<provider>), never
// the account-wide modelLock___all that getProviderCredentials reads for chat.
// Search failures must never lock chat.

const dbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn(),
  getCombos: vi.fn(),
  validateApiKey: vi.fn(),
  getProxyPools: vi.fn(),
}));
const tokenMocks = vi.hoisted(() => ({
  checkAndRefreshToken: vi.fn(),
  updateProviderCredentials: vi.fn(),
  persistRefreshedCredentials: vi.fn(),
  recordUnrecoverableRefreshFailure: vi.fn(),
}));

vi.mock("@/lib/localDb", () => dbMocks);
vi.mock("@/lib/network/connectionProxy", () => ({
  pickProxyPoolId: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(async () => ({ connectionProxyEnabled: false, connectionProxyUrl: "" })),
}));
vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  request: vi.fn(), maskKey: (key) => key,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => tokenMocks);
vi.mock("open-sse/services/combo.js", () => ({
  handleComboChat: vi.fn(),
  getComboModelsFromData: vi.fn(() => null),
}));
vi.mock("open-sse/handlers/search/index.js", () => ({ handleSearchCore: vi.fn() }));

const { handleSearch } = await import("@/sse/handlers/search.js");
const { getProviderCredentials } = await import("@/sse/services/auth.js");

const conns = [];
const conn = (overrides = {}) => ({
  id: "conn-tav", provider: "tavily", isActive: true, name: "tavily-a",
  accessToken: "tok-1", testStatus: "active", ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  conns.splice(0, conns.length, conn());
  dbMocks.getProviderConnections.mockResolvedValue(conns);
  dbMocks.getSettings.mockResolvedValue({ requireApiKey: false });
  dbMocks.getCombos.mockResolvedValue([]);
  dbMocks.updateProviderConnection.mockImplementation(async (id, update) => {
    const c = conns.find(x => x.id === id);
    if (c) Object.assign(c, update);
  });
  tokenMocks.checkAndRefreshToken.mockImplementation(async (_provider, creds) => creds);
});

const request = (body) => new Request("http://localhost:20128/v1/search", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("search token-refresh failure lock scope", () => {
  it("locks only modelLock_websearch:<provider>, not the account-wide lock", async () => {
    tokenMocks.checkAndRefreshToken.mockResolvedValueOnce({ connectionId: "conn-tav", _needsReauth: true });

    const res = await handleSearch(request({ provider: "tavily", query: "hello" }));
    expect(res.status).toBe(401);

    expect(dbMocks.updateProviderConnection).toHaveBeenCalledTimes(1);
    const update = dbMocks.updateProviderConnection.mock.calls[0][1];
    expect(update["modelLock_websearch:tavily"]).toBeTruthy();
    expect(update).not.toHaveProperty("modelLock___all");
    expect(update.testStatus).toBe("unavailable");
    expect(update.errorCode).toBe(401);
  });

  it("chat credentials remain selectable while the search lock is active", async () => {
    tokenMocks.checkAndRefreshToken.mockResolvedValueOnce({ connectionId: "conn-tav", _needsReauth: true });
    await handleSearch(request({ provider: "tavily", query: "hello" }));

    const chat = await getProviderCredentials("tavily", null, null);
    expect(chat.connectionId).toBe("conn-tav");

    const search = await getProviderCredentials("tavily", null, "websearch:tavily");
    expect(search.allRateLimited).toBe(true);
  });
});
