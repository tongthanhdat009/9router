import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ROUTES, mockZcodeGateway, redacted, resetZcodeGateway } from "../fixtures/zcode-mock-gateway.mjs";

describe("zcode Option B fixture and dashboard contract", () => {
  it("fixture covers personal mint, ticket lifecycle routes, and redacts keys", async () => {
    resetZcodeGateway();
    const handler = mockZcodeGateway({ df8d: "df8dfixture000000000001" });
    const customer = await handler(ROUTES.customerInfo, { headers: { Authorization: "raw-token" } });
    const take = await handler(ROUTES.take, { method: "POST" });
    const status = await handler(ROUTES.status, { method: "POST" });
    expect((await customer.json()).data.codingPlanApiKey).toMatch(/^df8d/);
    expect((await take.json()).data.ticket_id).toBe("tk-fixture");
    expect((await status.json()).data.status).toBe("active");
    expect(redacted("df8dfixture000000000001")).toBe("df8dfi...");
  });

  it("dashboard probe uses raw token and the generic error/status writer", () => {
    const source = readFileSync(new URL("../../src/app/api/providers/[id]/test/testUtils.js", import.meta.url), "utf8");
    expect(source).toContain('case "zcode"');
    expect(source).toContain('if (connection.provider === "zcode") return probeZcodeConnection');
    expect(source).toContain('Authorization: accessToken');
    expect(source).toContain('coding_plan_not_entitled');
    expect(source).toContain('testStatus: result.valid ? "active" : "error"');
  });
});
