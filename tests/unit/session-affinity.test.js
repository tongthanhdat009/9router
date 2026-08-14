import { beforeEach, describe, expect, it } from "vitest";
import {
  bindAccountAffinity,
  bindRouteAffinity,
  clearSessionAffinity,
  getAccountAffinity,
  getRouteAffinity,
  invalidateAccountAffinity,
  invalidateRouteAffinity,
} from "../../src/sse/services/sessionAffinity.js";

describe("session affinity", () => {
  beforeEach(clearSessionAffinity);

  it("pins account by session/provider/model and removes stale bindings", () => {
    bindAccountAffinity("S", "codex", "gpt", "A");
    expect(getAccountAffinity("S", "codex", "gpt")?.connectionId).toBe("A");
    expect(getAccountAffinity("S", "codex", "other")).toBeNull();
    invalidateAccountAffinity("S", "codex", "gpt");
    expect(getAccountAffinity("S", "codex", "gpt")).toBeNull();
  });

  it("pins combo route independently and invalidates on failover", () => {
    bindRouteAffinity("S", "combo", "codex/gpt");
    expect(getRouteAffinity("S", "combo")?.route).toBe("codex/gpt");
    invalidateRouteAffinity("S", "combo");
    expect(getRouteAffinity("S", "combo")).toBeNull();
  });
  it("no session identity -> no affinity -> falls through", () => {
    bindAccountAffinity("S", "codex", "gpt", "A");
    expect(getAccountAffinity(null, "codex", "gpt")).toBeNull();
    expect(getRouteAffinity(null, "combo")).toBeNull();
  });

});
