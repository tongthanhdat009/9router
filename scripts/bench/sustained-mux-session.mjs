// Sustained Mux-Style Working Session Benchmark (Section 33).
// Replays growing conversations, multiple projects, fan-out sub-agents, small probes,
// proxy rotation with >20 unique proxies to test eviction, and long streams over duration.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { execFileSync } from "node:child_process";
import { loadSessionMessages, buildCheckpoints, buildChildContext, estimateTokens } from "./mux-fixtures.mjs";

const DURATION_SECS = Number(process.env.BENCH_DURATION_SECS || 90);
const HOME = os.homedir();
const SOURCES = {
  softsync: HOME + "/.mux/sessions/6d189e8a9d/chat.jsonl",
  computeruse: HOME + "/.mux/sessions/e8cf0d0b8f/chat.jsonl",
  router9: HOME + "/.mux/sessions/4bb8445a74/chat.jsonl",
  nexpress: HOME + "/.mux/sessions/4788ba8b9a/chat.jsonl",
  vieclam: HOME + "/.mux/sessions/d62687c544/chat.jsonl",
  mux: HOME + "/.mux/sessions/2751596e75/chat.jsonl",
};

function percentile(arr, p) { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] || 0; }
function stats(arr) { if (!arr.length) return {}; return { p50: +percentile(arr, 0.5).toFixed(2), p95: +percentile(arr, 0.95).toFixed(2), p99: +percentile(arr, 0.99).toFixed(2), max: +Math.max(...arr).toFixed(2), mean: +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) }; }
function getFdCount() { try { return fs.readdirSync("/proc/self/fd").length; } catch { return 0; } }

function listen(server) { return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port))); }
function close(server) { return new Promise((resolve) => server.close(resolve)); }

function makeUpstream(keyFile, certFile) {
  const stats = { connects: 0, requests: 0 };
  const server = https.createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }, (req, res) => {
    let size = 0;
    req.on("data", (c) => { size += c.length; });
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
      client.write("HTTP/1.1 200 Connection Established" + "\r\n\r\n");
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

async function runOne(executor, provider, messages, creds, proxyOptions, ttfts) {
  const body = { model: provider === "antigravity" ? "gemini-2.5-pro" : "benchmark-model", stream: true, messages };
  const t0 = performance.now();
  const { response } = await executor.execute({ model: body.model, body, stream: true, credentials: creds, proxyOptions, log: { debug() {}, warn() {}, info() {}, error() {} } });
  const reader = response.body.getReader();
  const first = await reader.read();
  ttfts.push(performance.now() - t0);
  while (!(await reader.read()).done) {}
}

async function main() {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "9router-sustained-mux-"));
  process.env.DATA_DIR = path.join(temp, "data"); fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
  const keyFile = path.join(temp, "key.pem"); const certFile = path.join(temp, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=127.0.0.1", "-keyout", keyFile, "-out", certFile, "-days", "1"], { stdio: "ignore" });
  const upstream = makeUpstream(keyFile, certFile);
  const upstreamPort = await listen(upstream.server);
  const upstreamUrl = "https://127.0.0.1:" + upstreamPort;

  // Real CONNECT proxy server
  const proxy = makeProxyServer();
  const proxyPort = await listen(proxy.server);
  const baseProxyUrl = "http://127.0.0.1:" + proxyPort;

  const modules = await Promise.all([
    import("../../open-sse/executors/codex.js"), import("../../open-sse/executors/default.js"),
    import("../../open-sse/executors/antigravity.js"), import("../../open-sse/executors/muse.js"),
    import("../../open-sse/executors/opencode.js"), import("../../open-sse/executors/opencode-go.js"),
    import("../../src/lib/db/index.js"), import("../../src/sse/services/auth.js"),
    import("../../open-sse/utils/proxyFetch.js")
  ]);
  const [{ CodexExecutor }, { DefaultExecutor }, { AntigravityExecutor }, { MuseExecutor }, { OpenCodeExecutor }, { OpenCodeGoExecutor }, db, auth, { proxyDispatchers }] = modules;
  await db.initDb();

  const executors = {
    codex: patchExecutor(new CodexExecutor(), upstreamUrl),
    openrouter: patchExecutor(new DefaultExecutor("openrouter"), upstreamUrl),
    antigravity: patchExecutor(new AntigravityExecutor(), upstreamUrl),
    glm: patchExecutor(new DefaultExecutor("glm"), upstreamUrl),
    muse: patchExecutor(new MuseExecutor(), upstreamUrl),
    "opencode-go": patchExecutor(new OpenCodeGoExecutor(), upstreamUrl),
    opencode: patchExecutor(new OpenCodeExecutor(), upstreamUrl)
  };
  const baseCreds = {
    codex: { accessToken: "bench", providerSpecificData: {} },
    openrouter: { apiKey: "bench", providerSpecificData: {} },
    antigravity: { accessToken: "bench", projectId: "bench", providerSpecificData: {} },
    glm: { apiKey: "bench", providerSpecificData: {} },
    muse: { apiKey: "bench", providerSpecificData: { apiBaseUrl: upstreamUrl + "/v1" } }
  };

  // Pre-load distinct project fixtures
  const pComputerUse = loadSessionMessages(SOURCES.computeruse);
  const p9Router = loadSessionMessages(SOURCES.router9);
  const pSoftSync = loadSessionMessages(SOURCES.softsync);
  const pNexpress = loadSessionMessages(SOURCES.nexpress);
  const pVieclam = loadSessionMessages(SOURCES.vieclam);
  const pSmallVictim = [{ role: "system", content: "short" }, { role: "user", content: "ok" }];

  // Track metrics
  const samples = [];
  const ttfts = { parent: [], children: [], victim: [], proxy: [] };
  let totalRequests = 0;
  let running = true;
  const loop = monitorEventLoopDelay({ resolution: 5 }); loop.enable();
  const startMem = process.memoryUsage();
  const startFd = getFdCount();
  const startTime = Date.now();
  const deadline = startTime + (DURATION_SECS * 1000);

  // Periodic sampler (every 1s)
  const sampler = setInterval(() => {
    const mem = process.memoryUsage();
    samples.push({
      elapsedSecs: Math.round((Date.now() - startTime) / 1000),
      heapUsedMB: +(mem.heapUsed / 1048576).toFixed(1),
      rssMB: +(mem.rss / 1048576).toFixed(1),
      externalMB: +(mem.external / 1048576).toFixed(1),
      openFds: getFdCount(),
      dispatcherCount: proxyDispatchers ? proxyDispatchers.size : 0,
      requestsTotal: totalRequests
    });
  }, 1000);

  // Worker 1: Project A (ComputerUse) — Parent grows over time + 4 children repeatedly
  const workerProjA = (async () => {
    let growthIdx = 100;
    while (running && Date.now() < deadline) {
      // parent request (grows with turns)
      const slice = pComputerUse.slice(0, Math.min(pComputerUse.length, growthIdx));
      await runOne(executors.codex, "codex", slice, baseCreds.codex, null, ttfts.parent);
      totalRequests++;
      // 4 child agents in parallel
      const children = Array.from({ length: 4 }, (_, i) => buildChildContext(pComputerUse, i, 4, 40000));
      await Promise.all(children.map((c, i) => {
        const cp = i % 2 ? "openrouter" : "codex";
        return runOne(executors[cp], cp, c, baseCreds[cp], null, ttfts.children).then(() => { totalRequests++; });
      }));
      growthIdx = (growthIdx + 40) % (pComputerUse.length + 40);
      if (growthIdx < 50) growthIdx = 50;
      await new Promise((r) => setTimeout(r, 20));
    }
  })();

  // Worker 2: Project B (SoftSync / 9Router) — Medium threads (antigravity, glm)
  const workerProjB = (async () => {
    while (running && Date.now() < deadline) {
      await runOne(executors.antigravity, "antigravity", pSoftSync.slice(0, 150), baseCreds.antigravity, null, ttfts.parent);
      totalRequests++;
      await runOne(executors.glm, "glm", p9Router.slice(0, 150), baseCreds.glm, null, ttfts.parent);
      totalRequests++;
      await new Promise((r) => setTimeout(r, 20));
    }
  })();

  // 30 real CONNECT proxies on distinct loopback ports (cache max 20 -> continuous eviction)
  const proxyFleet = [];
  for (let i = 0; i < 30; i++) {
    const p = makeProxyServer();
    const port = await listen(p.server);
    proxyFleet.push({ server: p.server, stats: p.stats, url: "http://127.0.0.1:" + port });
  }

  // Worker 3: OpenCode Go/Free rotating through 30 unique proxy URLs (stressing eviction)
  const workerProxy = (async () => {
    let proxyIdx = 0;
    while (running && Date.now() < deadline) {
      const url = proxyFleet[proxyIdx++ % proxyFleet.length].url;
      const pOpt = { enabled: true, url, strictProxy: true };
      const creds = { apiKey: "public", providerSpecificData: { proxyPoolId: "bench-p" } };
      await runOne(executors["opencode-go"], "opencode-go", pVieclam, creds, pOpt, ttfts.proxy);
      totalRequests++;
      await runOne(executors.opencode, "opencode", pNexpress.slice(0, 50), creds, pOpt, ttfts.proxy);
      totalRequests++;
      await new Promise((r) => setTimeout(r, 15));
    }
  })();

  // Worker 4: Small Victim Probes every 100ms
  const workerVictim = (async () => {
    while (running && Date.now() < deadline) {
      await runOne(executors.openrouter, "openrouter", pSmallVictim, baseCreds.openrouter, null, ttfts.victim);
      totalRequests++;
      await new Promise((r) => setTimeout(r, 100));
    }
  })();

  await Promise.all([workerProjA, workerProjB, workerProxy, workerVictim]);
  running = false;
  clearInterval(sampler);
  loop.disable();

  // Let event loop settle and run GC if exposed
  await new Promise((r) => setTimeout(r, 500));
  if (globalThis.gc) globalThis.gc();
  const endMem = process.memoryUsage();
  const endFd = getFdCount();

  const peakHeap = Math.max(...samples.map((s) => s.heapUsedMB));
  const peakRss = Math.max(...samples.map((s) => s.rssMB));
  const peakFds = Math.max(...samples.map((s) => s.openFds));
  const peakDispatchers = Math.max(...samples.map((s) => s.dispatcherCount));

  const result = {
    durationSecs: DURATION_SECS,
    totalRequests,
    throughputRps: +(totalRequests / DURATION_SECS).toFixed(1),
    ttfts: {
      parent: stats(ttfts.parent),
      children: stats(ttfts.children),
      victim: stats(ttfts.victim),
      proxy: stats(ttfts.proxy),
    },
    resources: {
      startHeapMB: +(startMem.heapUsed / 1048576).toFixed(1),
      peakHeapMB: peakHeap,
      endHeapMB: +(endMem.heapUsed / 1048576).toFixed(1),
      startRssMB: +(startMem.rss / 1048576).toFixed(1),
      peakRssMB: peakRss,
      endRssMB: +(endMem.rss / 1048576).toFixed(1),
      startFds: startFd,
      peakFds: peakFds,
      endFds: endFd,
      maxDispatchers: peakDispatchers,
      endDispatchers: proxyDispatchers ? proxyDispatchers.size : 0
    },
    eventLoop: {
      meanMs: +(Number(loop.mean) / 1e6).toFixed(3),
      p95Ms: +(loop.percentile(95) / 1e6).toFixed(3),
      maxMs: +(loop.max / 1e6).toFixed(3)
    },
    samples: samples.filter((_, i) => i % 5 === 0 || i === samples.length - 1)
  };

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  await close(upstream.server); await close(proxy.server);
  for (const p of proxyFleet) await close(p.server);
  fs.rmSync(temp, { recursive: true, force: true });
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
