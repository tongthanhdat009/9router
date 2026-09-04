// Compares:
// 1. Same Provider: heavy workers on same provider as victim
// 2. Mixed Providers: heavy workers distributed across different providers
// 3. Proxy Isolation: heavy workers through proxy pool vs direct victim
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { execFileSync } from "node:child_process";
import { loadSessionMessages } from "./mux-fixtures.mjs";

const HOME = os.homedir();
const pComputerUse = loadSessionMessages(HOME + "/.mux/sessions/e8cf0d0b8f/chat.jsonl");
const victimMsgs = [{ role: "system", content: "You are concise." }, { role: "user", content: "ping" }];

function percentile(arr, p) { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] || 0; }
function stats(arr) { if (!arr.length) return {}; return { p50: +percentile(arr, 0.5).toFixed(2), p95: +percentile(arr, 0.95).toFixed(2), p99: +percentile(arr, 0.99).toFixed(2), max: +Math.max(...arr).toFixed(2), mean: +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) }; }

function listen(server) { return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port))); }
function close(server) { return new Promise((resolve) => server.close(resolve)); }

function makeUpstream(keyFile, certFile) {
  const stats = { connects: 0, requests: 0 };
  const server = https.createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }, (req, res) => {
    let bytes = 0;
    req.on("data", (c) => { bytes += c.length; });
    req.on("end", () => {
      stats.requests++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"ok"}}]}' + '\n\n');
      res.write('data: [DONE]' + '\n\n');
      res.end();
    });
  });
  return { server, stats };
}

function makeProxyServer() {
  const stats = { connects: 0 };
  const server = http.createServer((_req, res) => res.writeHead(405).end());
  server.on("connect", (req, client, head) => {
    stats.connects++;
    const [host, rawPort] = req.url.split(":");
    const target = net.connect(Number(rawPort), host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) target.write(head);
      client.pipe(target); target.pipe(client);
    });
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

async function runOne(executor, provider, messages, creds, proxyOptions, timing) {
  const body = { model: provider === "antigravity" ? "gemini-2.5-pro" : "benchmark-model", stream: true, messages };
  const t0 = performance.now();
  const { response } = await executor.execute({ model: body.model, body, stream: true, credentials: creds, proxyOptions, log: { debug() {}, warn() {}, info() {}, error() {} } });
  const reader = response.body.getReader();
  const first = await reader.read();
  timing.push(performance.now() - t0);
  while (!(await reader.read()).done) {}
}

async function main() {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "9router-contention-"));
  process.env.DATA_DIR = path.join(temp, "data"); fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
  const keyFile = path.join(temp, "key.pem"); const certFile = path.join(temp, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=127.0.0.1", "-keyout", keyFile, "-out", certFile, "-days", "1"], { stdio: "ignore" });
  const upstream = makeUpstream(keyFile, certFile);
  const upstreamPort = await listen(upstream.server);
  const upstreamUrl = "https://127.0.0.1:" + upstreamPort;

  const proxy = makeProxyServer();
  const proxyPort = await listen(proxy.server);
  const proxyUrl = "http://127.0.0.1:" + proxyPort;

  const modules = await Promise.all([
    import("../../open-sse/executors/codex.js"), import("../../open-sse/executors/default.js"),
    import("../../open-sse/executors/antigravity.js"), import("../../open-sse/executors/opencode.js"),
    import("../../open-sse/executors/opencode-go.js"), import("../../src/lib/db/index.js")
  ]);
  const [{ CodexExecutor }, { DefaultExecutor }, { AntigravityExecutor }, { OpenCodeExecutor }, { OpenCodeGoExecutor }, db] = modules;
  await db.initDb();

  const executors = {
    codex: patchExecutor(new CodexExecutor(), upstreamUrl),
    openrouter: patchExecutor(new DefaultExecutor("openrouter"), upstreamUrl),
    antigravity: patchExecutor(new AntigravityExecutor(), upstreamUrl),
    glm: patchExecutor(new DefaultExecutor("glm"), upstreamUrl),
    opencode: patchExecutor(new OpenCodeExecutor(), upstreamUrl),
    "opencode-go": patchExecutor(new OpenCodeGoExecutor(), upstreamUrl)
  };
  const baseCreds = {
    codex: { accessToken: "bench", providerSpecificData: {} },
    openrouter: { apiKey: "bench", providerSpecificData: {} },
    antigravity: { accessToken: "bench", projectId: "bench", providerSpecificData: {} },
    glm: { apiKey: "bench", providerSpecificData: {} },
    opencode: { apiKey: "bench", providerSpecificData: {} },
    "opencode-go": { apiKey: "bench", providerSpecificData: {} }
  };
  const proxyOptions = { enabled: true, url: proxyUrl, strictProxy: true };

  const modes = [
    { name: "Same Provider (All OpenRouter)", heavyWorkers: Array(4).fill({ provider: "openrouter", proxy: false }) },
    { name: "Same Provider (All Codex)", heavyWorkers: Array(4).fill({ provider: "codex", proxy: false }) },
    { name: "Mixed Providers (Codex+Antigravity+GLM+OpenRouter)", heavyWorkers: [{ provider: "codex", proxy: false }, { provider: "antigravity", proxy: false }, { provider: "glm", proxy: false }, { provider: "openrouter", proxy: false }] },
    { name: "Proxy Pool (All OpenCode via CONNECT)", heavyWorkers: Array(4).fill({ provider: "opencode-go", proxy: true }) },
  ];

  const results = [];

  for (const m of modes) {
    const victimTtfts = [];
    let running = true;
    const loop = monitorEventLoopDelay({ resolution: 5 }); loop.enable();
    const victimLoop = (async () => {
      while (running) {
        await runOne(executors.openrouter, "openrouter", victimMsgs, baseCreds.openrouter, null, victimTtfts);
        await new Promise((r) => setTimeout(r, 60));
      }
    })();

    const deadline = Date.now() + 2500;
    await Promise.all(m.heavyWorkers.map(async (hw) => {
      while (Date.now() < deadline) {
        await runOne(executors[hw.provider], hw.provider, pComputerUse, baseCreds[hw.provider], hw.proxy ? proxyOptions : null, []);
      }
    }));

    running = false;
    await victimLoop;
    loop.disable();

    results.push({
      mode: m.name,
      victimTtft: stats(victimTtfts),
      sampleCount: victimTtfts.length,
      elP95: +(loop.percentile(95) / 1e6).toFixed(2)
    });
  }

  process.stdout.write(JSON.stringify(results, null, 2) + "\n");
  await close(upstream.server); await close(proxy.server);
  fs.rmSync(temp, { recursive: true, force: true });
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
