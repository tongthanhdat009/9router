// In-process mock of the ZCode server surface Option B depends on, mirroring
// ZCode startOffPeakMockGateway route semantics (handoff D) + getCustomerInfo.
// Redaction helper: prefix-only logging of key material.
export const ROUTES = {
  customerInfo: "https://api.z.ai/api/biz/customer/getCustomerInfo",
  availability: "https://zcode.z.ai/api/v1/off-peak/ticket/availability",
  take: "https://zcode.z.ai/api/v1/off-peak/ticket",
  status: "https://zcode.z.ai/api/v1/off-peak/ticket/status",
  balance: "https://zcode.z.ai/api/v1/zcode-plan/billing/balance",
};

const state = { mode: "ok", takes: 0 };

export function resetZcodeGateway(mode) {
  state.mode = mode || "ok";
  state.takes = 0;
}

export function redacted(value) {
  if (typeof value !== "string" || value.length < 8) return "<short>";
  return value.slice(0, 6) + "...";
}

function res(payload, status) {
  return { ok: (status || 200) < 400, status: status || 200, headers: { get: () => null }, json: () => Promise.resolve(payload), text: () => Promise.resolve(JSON.stringify(payload)) };
}

export function mockZcodeGateway(opts) {
  const o = opts || {};
  return async (url, options) => {
    options = options || {};
    if (url === ROUTES.customerInfo) {
      if (state.mode === "auth-failed") return res({ error: "invalid token" }, 401);
      if (state.mode === "not-entitled") return res({ code: 0, data: { plan: "none", message: "no coding plan" } });
      return res({ code: 0, data: { codingPlanApiKey: o.df8d || "df8dfixture000000000001" } });
    }
    if (url === ROUTES.balance) return res({ code: 0, data: { configs: { offPeak: { enable_offpeak_task: true, allowed_models: ["glm-5.3-flash"] } } } });
    if (url === ROUTES.availability) return res({ code: 0, data: { can_take_number: true } });
    if (url === ROUTES.take && options.method === "POST") { state.takes += 1; return res({ code: 0, data: { ticket_id: "tk-fixture", status: "active" } }); }
    if (url === ROUTES.status) return res({ code: 0, data: { status: "active", next_poll_after: 0 } });
    throw new Error("fixture: unexpected " + url);
  };
}
