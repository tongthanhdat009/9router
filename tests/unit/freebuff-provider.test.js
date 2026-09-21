import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { hasSpecializedExecutor, getExecutor } from "../../open-sse/executors/index.js";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { APIKEY_PROVIDERS } from "../../src/shared/constants/providers.js";

describe("FreeBuff provider", () => {
  const freebuff = REGISTRY.find((entry) => entry.id === "freebuff");
  const modelIds = [
    "z-ai/glm-5.3-flash",
    "deepseek/deepseek-v4.1-flash",
    "openai/gpt-5.6-luna",
    "mimo/mimo-v2.5",
    "upstage/solar-pro4",
    "google/gemini-3.8-flash",
  ];

  it("derives the canonical OpenAI transport and API-key setup entry", () => {
    expect(freebuff).toMatchObject({
      id: "freebuff",
      alias: "freebuff",
      category: "apikey",
      display: {
        website: "https://freebuff.com",
        notice: { apiKeyUrl: "https://freebuff.com" },
      },
      transport: { baseUrl: "https://www.codebuff.com/api/v1/chat/completions" },
    });
    expect(PROVIDERS.freebuff).toMatchObject({
      baseUrl: "https://www.codebuff.com/api/v1/chat/completions",
      format: "openai",
    });
    expect(APIKEY_PROVIDERS.freebuff).toBeDefined();
  });

  it("declares only the regular-picker chat models", () => {
    expect(PROVIDER_MODELS.freebuff.map((model) => model.id)).toEqual(modelIds);
  });

  it("routes through the FreebuffExecutor", () => {
    expect(hasSpecializedExecutor("freebuff")).toBe(true);
    expect(getExecutor("freebuff").constructor.name).toBe("FreebuffExecutor");
    expect(getExecutor("freebuff").buildHeaders({ apiKey: "token" }).Authorization).toBe("Bearer token");
  });

  it("offers OAuth + API-key dual mode from registry constants only", () => {
    expect(freebuff.hasOAuth).toBe(true);
    expect(freebuff.authModes).toEqual(["oauth", "apikey"]);
    expect(APIKEY_PROVIDERS.freebuff.hasOAuth).toBe(true);
    expect(APIKEY_PROVIDERS.freebuff.authModes).toEqual(["oauth", "apikey"]);
    const page = readFileSync(resolve("../src/app/(dashboard)/dashboard/providers/[id]/page.js"), "utf8");
    expect(page).toContain('authModes.includes("oauth")');
    expect(page).toContain('authModes.includes("apikey")');
  });
});
