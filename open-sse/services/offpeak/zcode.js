import crypto from "node:crypto";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";

// ZCode off-peak ticketing (take/poll layer ONLY — inference-layer 3105/3102
// retry lives in the executor). Per-connection lazy caches; window detection
// is SERVER-DRIVEN (can_take_number / next_take_at), never wall-clock.
const ORIGIN = "https://zcode.z.ai/api/v1/off-peak";
const ELIGIBILITY_TTL_MS = 5 * 60 * 1000;
const POLL_MAX_WAIT_MS = 30 * 1000;

const stateByConnection = new Map();

function stateFor(credentials) {
  const key = credentials?.connectionId || "";
  let state = stateByConnection.get(key);
  if (!state) {
    state = { cfg: null, cfgAt: 0, nextTakeAt: 0, activeTicket: null, inFlightTake: null };
    stateByConnection.set(key, state);
  }
  return state;
}

function authHeaders(credentials) {
  const psd = credentials?.providerSpecificData || {};
  return { Authorization: "Bearer " + (psd.zcodeJwtToken || ""), "X-Coding-Plan-Api-Key": psd.codingPlanApiKey || "" };
}

function offpeakLog(conn, model, layer, avail, ticket, code) {
  console.log("[DBG:OFFPEAK] conn=%s model=%s layer=%s avail=%s ticket=%s code=%s", conn, model, layer, avail, ticket, code);
}

async function getJson(url, headers, proxyOptions = null) {
  const response = await proxyAwareFetch(url, { headers: { ...headers, Accept: "application/json" } }, proxyOptions);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const err = new Error("zcode offpeak request failed (" + response.status + ")");
    err.status = response.status;
    const code = payload && (payload.code ?? payload.data?.code);
    if (code !== undefined && code !== null) err.code = code;
    const retryAfter = Number(response.headers?.get?.("retry-after"));
    if (Number.isFinite(retryAfter)) err.retryAfterMs = retryAfter * 1000;
    throw err;
  }
  return payload;
}

async function fetchEligibility(credentials, model, proxyOptions = null) {
  const state = stateFor(credentials);
  const now = Date.now();
  if (!state.cfg || now - state.cfgAt > ELIGIBILITY_TTL_MS) {
    const payload = await getJson("https://zcode.z.ai/api/v1/zcode-plan/billing/balance", authHeaders(credentials), proxyOptions);
    state.cfg = payload?.data?.configs?.offPeak || {};
    state.cfgAt = now;
  }
  const allowed = Array.isArray(state.cfg.allowed_models) ? state.cfg.allowed_models : [];
  return state.cfg.enable_offpeak_task === true && allowed.some((m) => typeof m === "string" && m.toLowerCase() === model.toLowerCase());
}

async function availability(credentials, proxyOptions = null) {
  const payload = await getJson(ORIGIN + "/ticket/availability", authHeaders(credentials), proxyOptions);
  const data = payload?.data || {};
  return { canTake: data.can_take_number === true, nextTakeAt: Number(data.next_take_at) || 0 };
}

async function takeTicket(credentials, proxyOptions = null) {
  const response = await proxyAwareFetch(ORIGIN + "/ticket", {
    method: "POST",
    headers: { ...authHeaders(credentials), "Content-Type": "application/json" },
    body: JSON.stringify({ task_id: "offpeak-" + crypto.randomUUID() }),
  }, proxyOptions);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const err = new Error("zcode take failed (" + response.status + ")");
    err.status = response.status;
    const code = payload && (payload.code ?? payload.data?.code);
    if (code !== undefined && code !== null) err.code = code;
    throw err;
  }
  return payload?.data || {};
}

async function postJson(url, credentials, proxyOptions = null) {
  const response = await proxyAwareFetch(url, { method: "POST", headers: { ...authHeaders(credentials), Accept: "application/json" }, body: "{}" }, proxyOptions);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const err = new Error("zcode request failed (" + response.status + ")");
    err.status = response.status;
    const code = payload && (payload.code ?? payload.data?.code);
    if (code !== undefined && code !== null) err.code = code;
    throw err;
  }
  return payload;
}

async function pollTicketStatus(credentials, ticketId, proxyOptions = null) {
  const deadline = Date.now() + POLL_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const payload = await getJson(ORIGIN + "/ticket/status", authHeaders(credentials), proxyOptions);
    const data = payload?.data || {};
    if (data.status === "active") return true;
    const waitMs = Math.min(30, Math.max(1, Number(data.next_poll_after) || 2)) * 1000;
    if (Date.now() + waitMs > deadline) return data.status === "active";
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  return false;
}

async function takeFreshTicket(credentials, model) {
  const state = stateFor(credentials);
  state.inFlightTake = state.inFlightTake || (async () => {
    try {
      const conn = credentials?.connectionId || "";
      offpeakLog(conn, model, "take", "", "", "");
      const data = await takeTicket(credentials);
      const ticketId = data.ticket_id || data.id;
      if (!ticketId) return null;
      const active = await pollTicketStatus(credentials, ticketId);
      if (!active) return null;
      state.activeTicket = ticketId;
      return ticketId;
    } finally {
      state.inFlightTake = null;
    }
  })();
  return state.inFlightTake;
}

export async function resolveOffPeakAccess(credentials, model, proxyOptions = null) {
  const conn = credentials?.connectionId || "";
  const jwt = credentials?.providerSpecificData?.zcodeJwtToken;
  if (!jwt) return { ok: false };
  const state = stateFor(credentials);

  try {
    const eligible = await fetchEligibility(credentials, model);
    if (!eligible) {
      offpeakLog(conn, model, "eligibility", "", "", "not-eligible");
      return { ok: false };
    }

    if (state.activeTicket) return { ok: true, ticketId: state.activeTicket };

    const now = Date.now();
    if (state.nextTakeAt && now < state.nextTakeAt) {
      offpeakLog(conn, model, "availability-suppressed", state.nextTakeAt, "", "");
      return { ok: false };
    }

    const avail = await availability(credentials);
    if (!avail.canTake) {
      if (avail.nextTakeAt) state.nextTakeAt = avail.nextTakeAt * 1000;
      offpeakLog(conn, model, "availability", avail.nextTakeAt, "", "closed");
      return { ok: false };
    }

    const ticketId = await takeFreshTicket(credentials, model);
    if (!ticketId) {
      offpeakLog(conn, model, "take", "", "", "no-ticket");
      return { ok: false };
    }
    offpeakLog(conn, model, "ticket", "", ticketId, "");
    return { ok: true, ticketId };
  } catch (error) {
    // TAKE/POLL layer error semantics (3105 not-ready, 3102 invalid/expired).
    if (error.code === 3105) {
      if (state.activeTicket) {
        offpeakLog(conn, model, "3105", "", state.activeTicket, 3105);
        return { ok: true, ticketId: state.activeTicket };
      }
      state.nextTakeAt = 0;
      offpeakLog(conn, model, "3105", "cleared", "", 3105);
      return { ok: false, code: 3105 };
    }
    if (error.code === 3102) {
      state.activeTicket = null;
      state.nextTakeAt = 0;
      try {
        const ticketId = await takeFreshTicket(credentials, model);
        if (ticketId) {
          offpeakLog(conn, model, "3102-retake", "", ticketId, 3102);
          return { ok: true, ticketId };
        }
      } catch (retryError) {
        offpeakLog(conn, model, "3102-retake-fail", "", "", retryError.code || "");
      }
      offpeakLog(conn, model, "3102", "", "", 3102);
      return { ok: false, code: 3102 };
    }
    offpeakLog(conn, model, "error", "", "", error.code || error.status || "");
    return { ok: false };
  }
}

export async function settleTicket(credentials, ticketId, proxyOptions = null) {
  try {
    await postJson(ORIGIN + "/ticket/" + encodeURIComponent(ticketId) + "/settle", credentials, proxyOptions);
    const state = stateFor(credentials);
    if (state.activeTicket === ticketId) state.activeTicket = null;
    return true;
  } catch (error) {
    console.log("[DBG:OFFPEAK] settle failed ticket=%s code=%s", ticketId, error.code || error.status || "");
    return false;
  }
}

export function clearZcodeOffpeakStateForTests() {
  stateByConnection.clear();
}
