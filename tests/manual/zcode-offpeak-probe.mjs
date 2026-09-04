/**
 * Manual probe (NO live network): stubs fetch, drives ZcodeExecutor off-peak
 * dispatch, prints outgoing url + auth headers. Run:
 *   node tests/manual/zcode-offpeak-probe.mjs
 * Gate: grep -cE "X-Off-Peak-Ticket-ID|off-peak/anthropic/v1/messages" >= 2
 */
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const realFetch = globalThis.fetch;
const calls = [];

globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  if (target.includes("zcode.z.ai") || target.includes("api.z.ai")) {
    calls.push({ url: target, headers: options.headers || {} });
    if (target.includes("/off-peak/ticket/availability")) {
      return new Response(JSON.stringify({ code: 0, data: { can_take_number: true } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (target.includes("/zcode-plan/billing/balance")) {
      return new Response(JSON.stringify({ code: 0, data: { configs: { offPeak: { enable_offpeak_task: true, allowed_models: ["glm-5.3-flash"] } } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (target.endsWith("/off-peak/ticket") && options.method === "POST") {
      return new Response(JSON.stringify({ code: 0, data: { ticket_id: "tk-probe-1", status: "active" } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (target.includes("/ticket/status")) {
      return new Response(JSON.stringify({ code: 0, data: { status: "active", next_poll_after: 0 } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (target.includes("/messages")) {
      return new Response(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  }
  return realFetch(url, options);
};

const { ZcodeExecutor } = await import("../../open-sse/executors/zcode.js");

const credentials = {
  connectionId: "conn-probe",
  accessToken: "zai-at",
  rawHeaders: {},
  providerSpecificData: { zcodeJwtToken: "jwt-probe", codingPlanApiKey: "key-probe", deviceId: "dev-probe", userId: "user-probe" },
};

const executor = new ZcodeExecutor();
const result = await executor.execute({
  model: "glm-5.3-flash",
  body: { model: "glm-5.3-flash", max_tokens: 16, messages: [{ role: "user", content: "ping" }] },
  stream: false,
  credentials,
  signal: undefined,
  log: console,
  proxyOptions: null,
  requestId: "probe-1",
});

for (const call of calls) {
  const headers = call.headers || {};
  const auth = headers["Authorization"] || headers["authorization"] || "";
  const ticket = headers["X-Off-Peak-Ticket-ID"] || headers["x-off-peak-ticket-id"] || "";
  console.log("[PROBE] url=" + call.url + " Authorization=" + auth + " X-Off-Peak-Ticket-ID=" + ticket + " x-api-key=" + (headers["x-api-key"] || ""));
}
console.log("[PROBE] result ok=" + !!result + " channel=" + (credentials.__zcodeChannel || {}).channel);
