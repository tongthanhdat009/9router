// Sanitized Mux chat-history fixtures. Converts ~/.mux/sessions/<id>/chat.jsonl rows
// {id, role, metadata, parts[]} into OpenAI-chat-shaped messages, preserving turn
// order, roles, reasoning, tool-call structure, code/diff/tool-result content, and
// realistic size distribution. Secrets redacted. Deterministic output.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const REDACT_PATTERNS = [
  /(?:authorization|cookie|set-cookie|api[-_ ]?secret|api[-_ ]?key|password|token|secret|bearer)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|eyJ[A-Za-z0-9._-]{20,})\b/g,
  /data:(?:image|audio|video)\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi,
];

function redact(text) {
  let out = String(text);
  for (const re of REDACT_PATTERNS) out = out.replace(re, (m) => {
    const head = m.split(/[:=]/, 1)[0] || m.slice(0, 4);
    return head + "=[REDACTED]";
  });
  return out;
}

// estimated tokens: UTF-8 bytes / 4 (same heuristic as benchmark-providers.mjs)
export function estimateTokens(str) { return Math.ceil(Buffer.byteLength(String(str), "utf8") / 4); }

// one Mux row -> chat messages; assistant rows with tool parts become assistant + tool messages
function rowToMessages(row) {
  const role = row.role === "user" ? "user" : "assistant";
  const msgs = [];
  const asstText = [];
  const toolCalls = [];
  const toolResults = [];
  for (const p of row.parts || []) {
    if (!p || typeof p !== "object") continue;
    if (p.type === "dynamic-tool") {
      toolCalls.push({ type: "function", id: p.toolCallId || ("call_" + toolCalls.length), function: { name: String(p.toolName || "tool"), arguments: safeJson(p.input) } });
      toolResults.push({ role: "tool", tool_call_id: p.toolCallId || ("call_" + toolResults.length), content: redact(outText(p.output)).slice(0, 4096) });
    } else {
      const t = redact(String(p.text || ""));
      if (t) asstText.push(t);
    }
  }
  if (role === "user" || (asstText.length === 0 && toolCalls.length === 0)) {
    msgs.push({ role, content: asstText.join("\n") || "[empty turn]" });
  } else if (role === "user" && toolCalls.length) {
    msgs.push({ role: "user", content: asstGoalText(asstText) });
  } else {
    if (asstText.length) msgs.push({ role: "assistant", content: asstText.join("\n") });
    if (toolCalls.length) msgs.push({ role: "assistant", content: "", tool_calls: toolCalls });
    for (const tr of toolResults) msgs.push(tr);
  }
  return msgs;
}

function asstGoalText(arr) { return arr.join("\n"); }

function outText(output) {
  if (output == null) return "";
  if (typeof output === "string") return output;
  if (typeof output === "object") {
    if (typeof output.output === "string") return output.output;
    return JSON.stringify(output);
  }
  return String(output);
}

function safeJson(v) {
  if (v == null) return "{}";
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return "{}"; }
}

// load one session file, sanitize, convert to messages
export function loadSessionMessages(file) {
  const raw = fs.readFileSync(file, "utf8");
  const messages = [];
  let sys = null;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || !Array.isArray(row.parts)) continue;
    if (sys === null) {
      // first assistant preamble becomes a system message in the fixture
      sys = { role: "system", content: "You are a coding agent operating on a local repository. Preserve behavior, inspect evidence, use tools, return minimal patches with verification. " + redact(String((row.parts[0] || {}).text || "")).slice(0, 2000) };
      messages.push(sys);
    }
    for (const m of rowToMessages(row)) {
      if (!m.content && !m.tool_calls) continue;
      messages.push(m);
    }
  }
  return messages;
}

// progressive checkpoints: prefix-of-history snapshots at target token counts
export function buildCheckpoints(messages, targets) {
  const out = [];
  let prefixTokens = 0;
  const prefixStats = [];
  for (const m of messages) {
    prefixTokens += estimateTokens(m.content || "");
    prefixStats.push(prefixTokens);
  }
  for (const target of targets) {
    let idx = 0;
    while (idx < prefixStats.length && prefixStats[idx] < target) idx++;
    let slice = messages.slice(0, Math.max(idx, 2));
    let curTokens = prefixStats[Math.min(idx, prefixStats.length - 1)] || 0;
    if (curTokens < target && messages.length > 2) {
      // extend using structurally realistic turns from the same session (distinct rotation)
      slice = [...slice];
      const usable = messages.filter((m) => m.role !== "system");
      let di = 0;
      while (curTokens < target && usable.length) {
        const piece = usable[di % usable.length];
        slice.push({ role: piece.role, content: piece.content, ...(piece.tool_call_id ? { tool_call_id: piece.tool_call_id } : {}), ...(piece.tool_calls ? { tool_calls: piece.tool_calls } : {}) });
        curTokens += estimateTokens(piece.content || "");
        di++;
      }
    }
    out.push({ targetTokens: target, messages: slice });
  }
  out.push({ targetTokens: prefixTokens, messages });
  return out;
}

// derive child-agent context from a parent history: shared system + a contiguous slice of the parent conversation + child task
export function buildChildContext(parentMessages, childIndex, childCount, sizeTokens) {
  // distinct slices per child so children are structurally different
  const usable = parentMessages.slice(1); // drop system
  const perChild = Math.max(2, Math.floor(usable.length / (childCount + 2)));
  const start = Math.min(Math.max(0, usable.length - perChild), childIndex * perChild);
  const ctx = usable.slice(start, start + perChild);
  const sys = { role: "system", content: parentMessages[0].content + " You are sub-agent #" + (childIndex + 1) + " of " + childCount + ". Task slice " + (childIndex + 1) + ": investigate the " + ["backend routing path", "auth path", "frontend panel", "test suite", "provider registry", "performance hot path", "edge cases", "regression baseline"][childIndex % 8] + "." };
  const msgs = [sys, ...ctx];
  // trim/extend to approximate target size by repeating realistic parent material (not identical filler)
  let tokens = msgs.reduce((a, m) => a + estimateTokens(m.content || ""), 0);
  let di = 0;
  while (tokens < sizeTokens && usable.length) {
    const piece = usable[(start + di) % usable.length];
    msgs.push({ role: piece.role, content: piece.content, ...(piece.tool_call_id ? { tool_call_id: piece.tool_call_id } : {}), ...(piece.tool_calls ? { tool_calls: piece.tool_calls } : {}) });
    tokens += estimateTokens(piece.content || "");
    di++;
  }
  return msgs;
}

// directory scan: pick N distinct project histories
export function listSessionFiles() {
  const dir = path.join(os.homedir(), ".mux", "sessions");
  const out = [];
  for (const id of fs.readdirSync(dir)) {
    const f = path.join(dir, id, "chat.jsonl");
    try {
      const st = fs.statSync(f);
      if (st.size > 400_000) out.push({ id, file: f, bytes: st.size });
    } catch {}
  }
  out.sort((a, b) => b.bytes - a.bytes);
  return out;
}
