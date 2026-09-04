// Reproducible local payload benchmark; no provider calls or live DATA_DIR.
// Run: node --no-warnings --loader ./scripts/benchmark-loader.mjs ./scripts/benchmark-providers.mjs > benchmark-results.json
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { execFileSync } from "node:child_process";

const PRIVATE_SOURCE = process.env.BENCH_CHAT_JSONL || "";
const SIZES = { small: [2400, 4, 2], medium: [24000, 28, 8], large: [900000, 520, 36], very_large: [1500000, 900, 48] };
const WORKLOADS = ["medium", "large"];
const CONCURRENCY = [1, 10, 25];
const PROVIDERS = ["codex", "openrouter", "antigravity", "glm", "muse", "opencode-go", "opencode"];
const TOKEN_ESTIMATE = "UTF-8 byte length / 4, rounded up (conservative heuristic for code-heavy English)";
const log = { debug() {}, warn() {}, info() {} };

function synthUnit(i) {
  return "File: src/services/request-router-" + (i % 37) + ".js\n" +
    "Context: inspect fallback ordering, preserve abort propagation, validate JSON at the HTTP boundary.\n" +
    "\x60\x60\x60js\nexport async function route" + i + "(request, accounts) {\n  const eligible = accounts.filter((item) => item.enabled && !item.cooldownUntil);\n  for (const account of eligible) {\n    try { return await account.execute(request, { signal: request.signal }); }\n    catch (error) { if (!error.retryable) throw error; }\n  }\n  throw new Error(\"no eligible account\");\n}\n\x60\x60\x60\n" +
    "Observed test " + i + ": expected stable provider affinity, bounded retries, streamed terminal event, and no secret-bearing logs.";
}

function redact(text) {
  return String(text)
    .replace(/data:(?:image|audio)\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, "[attachment omitted]")
    .replace(/(?:authorization|cookie|set-cookie|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|password)\s*[:=]\s*[^\s,;]+/gi, (m) => m.split(/[:=]/, 1)[0] + ": [REDACTED]")
    .replace(/(?:sk-|ghp_|github_pat_|eyJ)[A-Za-z0-9._-]{12,}/g, "[REDACTED]");
}

function collectPrivateText(limit) {
  if (!PRIVATE_SOURCE || !fs.existsSync(PRIVATE_SOURCE)) return { text: "", source: null };
  const bytes = fs.statSync(PRIVATE_SOURCE).size;
  const raw = fs.readFileSync(PRIVATE_SOURCE, "utf8");
  const parts = [];
  let length = 0;
  for (const line of raw.split("\n")) {
    if (length >= limit) break;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const role = row?.role || row?.message?.role || row?.type;
    const content = row?.content ?? row?.message?.content ?? row?.text;
    if (!content || /image|attachment|screenshot/i.test(String(role))) continue;
    const text = typeof content === "string" ? content : JSON.stringify(content);
    const clean = redact("[" + String(role || "event") + "] " + text);
    parts.push(clean); length += clean.length + 1;
  }
  return { text: parts.join("\n").slice(0, limit), source: { pathClass: "local Mux chat JSONL", bytes } };
}

function tool(i) {
  return { type: "function", function: { name: "inspect_repository_file_" + i, description: "Read a bounded source range and return numbered lines for a routing investigation.", parameters: { type: "object", properties: { path: { type: "string", description: "Repository-relative path" }, offset: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1, maximum: 200 }, query: { type: "string", description: "Symbol or behavior to inspect" } }, required: ["path", "offset", "limit"], additionalProperties: false } } };
}

function buildPayload(name) {
  const [targetChars, messageCount, toolCount] = SIZES[name];
  const privatePart = collectPrivateText(Math.floor(targetChars * 0.7));
  let corpus = privatePart.text;
  let i = 0;
  while (corpus.length < targetChars) corpus += "\n" + synthUnit(i++);
  corpus = corpus.slice(0, targetChars);
  const chunk = Math.ceil(corpus.length / messageCount);
  const messages = [{ role: "system", content: "You are a coding agent. Preserve behavior, inspect evidence, use tools, and return a minimal patch with verification." }];
  for (let n = 0; n < messageCount; n++) messages.push({ role: n % 3 === 2 ? "assistant" : "user", content: corpus.slice(n * chunk, (n + 1) * chunk) });
  const body = { model: "benchmark-model", stream: true, messages, tools: Array.from({ length: toolCount }, (_, n) => tool(n)), tool_choice: "auto" };
  const json = JSON.stringify(body);
  const bytes = Buffer.byteLength(json);
  return { body, stats: { name, bytes, estimatedTokens: Math.ceil(bytes / 4), estimationMethod: TOKEN_ESTIMATE, messages: messages.length, tools: toolCount, systemBytes: Buffer.byteLength(JSON.stringify(messages[0])), toolBytes: Buffer.byteLength(JSON.stringify(body.tools)), source: privatePart.source || { pathClass: "deterministic synthetic fallback", bytes: 0 }, sanitizerRules: ["omit image/audio data URLs and attachment/screenshot events", "redact auth/cookie/API-key/token/secret/password assignments", "redact sk-/ghp_/github_pat_/JWT-like tokens"] } };
}

const fixtures = Object.fromEntries(Object.keys(SIZES).map((name) => [name, buildPayload(name)]));
assert(fixtures.large.stats.estimatedTokens >= 220000, "large must exceed 220k estimated tokens");
assert(fixtures.very_large.stats.estimatedTokens >= 350000, "very_large must exceed 350k estimated tokens");

function percentile(values, p) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] || 0; }
function listen(server) { return new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address().port)); }); }
function close(server) { return new Promise((resolve) => server.close(resolve)); }

function makeUpstream(keyFile, certFile) {
  return https.createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }, async (req, res) => {
    let size = 0; for await (const chunk of req) size += chunk.length;
    const pathname = req.url || "";
    res.writeHead(200, { "content-type": "text/event-stream", "x-upload-bytes": String(size) });
    if (pathname.includes("generateContent")) res.write('data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n');
    else if (pathname.includes("/messages")) { res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","content":[],"model":"benchmark","stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n'); res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n'); res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n'); }
    else if (pathname.includes("/responses") || pathname.includes("/codex/")) { res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n'); res.write('event: response.completed\ndata: {"type":"response.completed"}\n\n'); }
    else { res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'); res.write('data: [DONE]\n\n'); }
    res.end();
  });
}

function makeConnectProxy() {
  const stats = { connects: 0, bytesUp: 0 };
  const server = http.createServer((_req, res) => res.writeHead(405).end());
  server.on("connect", (req, client, head) => {
    stats.connects++;
    const [host, rawPort] = req.url.split(":");
    const target = net.connect(Number(rawPort), host, () => { client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) { stats.bytesUp += head.length; target.write(head); } client.on("data", (chunk) => { stats.bytesUp += chunk.length; }); target.pipe(client); client.pipe(target); });
    target.on("error", () => client.destroy());
  });
  return { server, stats };
}

function patchExecutor(executor, upstream) {
  executor.config = { ...executor.config, retry: {}, timeoutMs: 30000, baseUrl: upstream, baseUrls: [upstream] };
  executor.getBaseUrls = () => [upstream];
  if (executor.provider === "codex") executor.buildUrl = () => upstream + "/codex/responses";
  if (executor.provider === "muse") executor.buildUrl = () => upstream + "/v1/responses";
  if (executor.provider === "antigravity") executor.buildUrl = (_m, stream) => upstream + (stream ? "/v1internal:streamGenerateContent?alt=sse" : "/v1internal:generateContent");
  if (executor.provider === "glm") executor.buildUrl = () => upstream + "/v1/messages";
  if (executor.provider === "openrouter") executor.buildUrl = () => upstream + "/v1/chat/completions";
  if (executor.provider === "opencode") executor.buildUrl = () => upstream + "/zen/v1/chat/completions";
  if (executor.provider === "opencode-go") executor.buildUrl = () => upstream + "/zen/go/v1/chat/completions";
  return executor;
}

async function main() {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const origLog = console.log;
  console.log = (...args) => { process.stderr.write(args.join(" ") + "\n"); };
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "9router-provider-bench-"));
  process.env.DATA_DIR = path.join(temp, "data"); fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
  const keyFile = path.join(temp, "key.pem"); const certFile = path.join(temp, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=127.0.0.1", "-keyout", keyFile, "-out", certFile, "-days", "1"], { stdio: "ignore" });
  const upstreamServer = makeUpstream(keyFile, certFile); const upstreamPort = await listen(upstreamServer); const upstream = "https://127.0.0.1:" + upstreamPort;
  const { server: proxyServer, stats: proxyStats } = makeConnectProxy(); const proxyPort = await listen(proxyServer); const proxyUrl = "http://127.0.0.1:" + proxyPort;
  const modules = await Promise.all([import("../open-sse/executors/codex.js"), import("../open-sse/executors/default.js"), import("../open-sse/executors/antigravity.js"), import("../open-sse/executors/muse.js"), import("../open-sse/executors/opencode.js"), import("../open-sse/executors/opencode-go.js"), import("../src/lib/db/index.js"), import("../src/sse/services/auth.js")]);
  const [{ CodexExecutor }, { DefaultExecutor }, { AntigravityExecutor }, { MuseExecutor }, { OpenCodeExecutor }, { OpenCodeGoExecutor }, db, auth] = modules;
  await db.initDb();
  const pool = await db.createProxyPool({ id: "bench-proxy", name: "local CONNECT", proxyUrl, type: "http", isActive: true, strictProxy: true });
  await db.createProviderConnection({ provider: "opencode-go", authType: "apikey", name: "bench-go", apiKey: "bench", providerSpecificData: { proxyPoolId: pool.id } });
  await db.createProviderConnection({ provider: "opencode", authType: "apikey", name: "bench-free", apiKey: "public", providerSpecificData: { proxyPoolId: pool.id } });
  await db.updateSettings({
    fallbackStrategy: "fill-first",
    providerStrategies: {
      opencode: { proxyPoolId: pool.id, rotateStrategy: "none" },
    },
  });
  const executors = { codex: patchExecutor(new CodexExecutor(), upstream), openrouter: patchExecutor(new DefaultExecutor("openrouter"), upstream), antigravity: patchExecutor(new AntigravityExecutor(), upstream), glm: patchExecutor(new DefaultExecutor("glm"), upstream), muse: patchExecutor(new MuseExecutor(), upstream), "opencode-go": patchExecutor(new OpenCodeGoExecutor(), upstream), opencode: patchExecutor(new OpenCodeExecutor(), upstream) };
  const baseCreds = { codex: { accessToken: "bench", providerSpecificData: {} }, openrouter: { apiKey: "bench", providerSpecificData: {} }, antigravity: { accessToken: "bench", projectId: "bench", providerSpecificData: {} }, glm: { apiKey: "bench", providerSpecificData: {} }, muse: { apiKey: "bench", providerSpecificData: { apiBaseUrl: upstream + "/v1" } } };
  async function credentialAndProxy(provider) {
    if (provider !== "opencode-go" && provider !== "opencode") return { credentials: baseCreds[provider], proxyOptions: null };
    const credentials = await auth.getProviderCredentials(provider, null, "benchmark-model"); assert(credentials); assert.equal(credentials.providerSpecificData.connectionProxyUrl, proxyUrl);
    return { credentials: { ...credentials, connectionId: credentials.id || "bench", rawHeaders: { "x-session-id": "bench-session" } }, proxyOptions: { enabled: credentials.providerSpecificData.connectionProxyEnabled, url: credentials.providerSpecificData.connectionProxyUrl, strictProxy: true } };
  }
  const results = [];
  for (const provider of PROVIDERS) for (const workload of WORKLOADS) for (const concurrency of CONCURRENCY) {
    const latencies = []; const ttfts = []; const heapStart = process.memoryUsage().heapUsed; const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable(); const start = performance.now();
    await Promise.all(Array.from({ length: concurrency }, async () => {
      const { credentials, proxyOptions } = await credentialAndProxy(provider); const body = structuredClone(fixtures[workload].body); const t0 = performance.now();
      const { response } = await executors[provider].execute({ model: provider === "antigravity" ? "gemini-2.5-pro" : "benchmark-model", body, stream: true, credentials, proxyOptions, log });
      assert.equal(response.status, 200); const reader = response.body.getReader(); const first = await reader.read(); assert.equal(first.done, false); ttfts.push(performance.now() - t0); while (!(await reader.read()).done) {} latencies.push(performance.now() - t0);
    }));
    const elapsedMs = performance.now() - start; loop.disable();
    results.push({ provider, workload, concurrency, input: fixtures[workload].stats, p50Ms: Number(percentile(latencies, 0.5).toFixed(3)), p95Ms: Number(percentile(latencies, 0.95).toFixed(3)), ttftP50Ms: Number(percentile(ttfts, 0.5).toFixed(3)), ttftP95Ms: Number(percentile(ttfts, 0.95).toFixed(3)), elapsedMs: Number(elapsedMs.toFixed(3)), heapDeltaBytes: process.memoryUsage().heapUsed - heapStart, eventLoopDelayMeanMs: Number((Number(loop.mean) / 1e6 || 0).toFixed(3)), eventLoopDelayP95Ms: Number((loop.percentile(95) / 1e6 || 0).toFixed(3)) });
  }
  const { cleanJSONSchemaForAntigravity: clean } = await import("../open-sse/translator/formats/gemini.js"); const agFixture = fixtures.large.body.tools.map((item) => structuredClone(item.function.parameters));
  function timeClean(duplicate) { const t0 = performance.now(); for (let round = 0; round < 4; round++) for (const schema of agFixture) { const first = clean(structuredClone(schema)); if (duplicate) clean(structuredClone(first)); } return performance.now() - t0; }
  const antigravityDuplicateClean = { optimizedMs: Number(timeClean(false).toFixed(3)), baselineDuplicateMs: Number(timeClean(true).toFixed(3)), workload: "large", iterations: 4 };
  assert(proxyStats.connects > 0, "OpenCode benchmark did not use CONNECT proxy");
  const payload = JSON.stringify({ metadata: { node: process.version, controlledLocalOnly: true, veryLargeNote: "Generated and reported only; provider model limits vary, never sent live or through provider-specific execution.", command: "node --no-warnings --loader ./scripts/benchmark-loader.mjs ./scripts/benchmark-providers.mjs > benchmark-results.json" }, fixtures: Object.fromEntries(Object.entries(fixtures).map(([name, value]) => [name, value.stats])), proxy: { type: "real local HTTP CONNECT", urlClass: "loopback temporary", connects: proxyStats.connects, uploadedEncryptedBytes: proxyStats.bytesUp, temporaryDataDir: true }, antigravityDuplicateClean, results }, null, 2);
  process.stdout.write(payload + "\n");
  await close(upstreamServer); await close(proxyServer); fs.rmSync(temp, { recursive: true, force: true });
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

