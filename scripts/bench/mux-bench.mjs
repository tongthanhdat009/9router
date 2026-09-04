// Mux-derived realistic workload benchmark for 9Router.
// Sources real sanitized Mux chat histories, replays them through real executor
// paths (parse -> transform -> serialize -> transport -> streaming) against
// controlled local upstreams. No provider calls, temp DATA_DIR only.
// Run: node --no-warnings --loader ./scripts/benchmark-loader.mjs scripts/bench/mux-bench.mjs > /tmp/mux-bench.json
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

const HOME = os.homedir();
// Real sanitized Mux histories (largest per project family)
const SOURCES = {
  softsync: HOME + "/.mux/sessions/6d189e8a9d/chat.jsonl",
  computeruse: HOME + "/.mux/sessions/e8cf0d0b8f/chat.jsonl",
  router9: HOME + "/.mux/sessions/4bb8445a74/chat.jsonl",
  nexpress: HOME + "/.mux/sessions/4788ba8b9a/chat.jsonl",
  vieclam: HOME + "/.mux/sessions/d62687c544/chat.jsonl",
  mux: HOME + "/.mux/sessions/2751596e75/chat.jsonl",
};
const CHECKPOINT_TOKENS = [25000, 50000, 100000, 150000, 200000, 250000, 300000];
const log = { debug() {}, warn() {}, info() {}, error() {} };

function percentile(arr, p) { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] || 0; }
function stats(arr) { if (!arr.length) return {}; return { p50: +percentile(arr, 0.5).toFixed(2), p95: +percentile(arr, 0.95).toFixed(2), p99: +percentile(arr, 0.99).toFixed(2), max: +Math.max(...arr).toFixed(2), mean: +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) }; }

function listen(server) { return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port))); }
function close(server) { return new Promise((resolve) => server.close(resolve)); }

// controlled upstream: echoes realistic streamed SSE per provider family, with realistic chunk counts
function makeUpstream(keyFile, certFile, opts = {}) {
  const stats = { connects: 0, requests: 0, bytesUp: 0 };
  const server = https.createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }, (req, res) => {
    let size = 0;
    req.on("data", (c) => { size += c.length; });
    req.on("end", () => {
      stats.requests++; stats.bytesUp += size;
      const pathname = req.url || "";
      res.writeHead(200, { "content-type": "text/event-stream" });
      // baseline: quick ok
      const chunks = opts.chunks ?? 24;
      const chunkText = opts.chunkText ?? "ok";
      const delay = opts.chunkDelayMs ?? 0;
      let i = 0;
      const emit = () => {
        if (pathname.includes("generateContent")) { res.write('data: {"candidates":[{"content":{"parts":[{"text":"' + chunkText + '"}]}}]}\n\n'); }
        else if (pathname.includes("/messages")) { res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"' + chunkText + '"}}\n\n'); }
        else if (pathname.includes("/responses") || pathname.includes("/codex/")) { res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"' + chunkText + '"}\n\n'); }
        else { res.write('data: {"choices":[{"delta":{"content":"' + chunkText + '"}}]}\n\n'); }
        i++;
        if (i < chunks) { if (delay) setTimeout(emit, delay); else emit(); }
        else {
          if (pathname.includes("/messages")) { res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n'); }
          else if (pathname.includes("/responses") || pathname.includes("/codex/")) { res.write('event: response.completed\ndata: {"type":"response.completed"}\n\n'); }
          else { res.write("data: [DONE]\n\n"); }
          res.end();
        }
      };
      emit();
    });
  });
  server.on("connect", (req, client) => {
    stats.connects++;
    const [host, rawPort] = req.url.split(":");
    const target = net.connect(Number(rawPort), host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      client.pipe(target); target.pipe(client);
    });
    target.on("error", () => client.destroy());
  });
  return { server, stats };
}

// long-stream upstream for streaming scenarios: many chunks, realistic sizes
function makeLongStreamUpstream(keyFile, certFile, { chunks, chunkBytes }) {
  const stats = { requests: 0, bytesUp: 0 };
  const server = https.createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }, (req, res) => {
    let size = 0;
    req.on("data", (c) => { size += c.length; });
    req.on("end", () => {
      stats.requests++; stats.bytesUp += size;
      const pathname = req.url || "";
      res.writeHead(200, { "content-type": "text/event-stream" });
      const text = "x".repeat(chunkBytes);
      let i = 0;
      const emit = () => {
        if (i >= chunks) { res.write("data: [DONE]\n\n"); res.end(); return; }
        if (pathname.includes("/messages")) res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"' + text + '"}}\n\n');
        else if (pathname.includes("/responses") || pathname.includes("/codex/")) res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"' + text + '"}\n\n');
        else res.write('data: {"choices":[{"delta":{"content":"' + text + '"}}]}\n\n');
        i++;
        setImmediate(emit);
      };
      emit();
    });
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

// stage-timed single request through a real executor
async function runOne(executor, provider, messages, creds, proxyOptions, timing) {
  const body = { model: provider === "antigravity" ? "gemini-2.5-pro" : "benchmark-model", stream: true, messages };
  const t0 = performance.now();
  const { response } = await executor.execute({ model: body.model, body, stream: true, credentials: creds, proxyOptions, log });
  const tUpstreamResp = performance.now();
  const reader = response.body.getReader();
  const first = await reader.read();
  const tFirstChunk = performance.now();
  while (!(await reader.read()).done) {}
  const tEnd = performance.now();
  timing.push({ prep: tUpstreamResp - t0, ttft: tFirstChunk - t0, total: tEnd - t0, stream: tEnd - tFirstChunk });
  return first;
}

async function main() {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const origLog = console.log;
  console.log = (...args) => { process.stderr.write(args.join(" ") + "\n"); };
  const mode = process.argv[2] || "growth";
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "9router-mux-bench-"));
  process.env.DATA_DIR = path.join(temp, "data"); fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
  const keyFile = path.join(temp, "key.pem"); const certFile = path.join(temp, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=127.0.0.1", "-keyout", keyFile, "-out", certFile, "-days", "1"], { stdio: "ignore" });
  const upstream = makeUpstream(keyFile, certFile);
  const upstreamPort = await listen(upstream.server);
  const upstreamUrl = "https://127.0.0.1:" + upstreamPort;
  function makeConnectProxy() {
    const stats = { connects: 0, bytesUp: 0 };
    const server = http.createServer((_req, res) => res.writeHead(405).end());
    server.on("connect", (req, client, head) => {
      stats.connects++;
      const [host, rawPort] = req.url.split(":");
      const target = net.connect(Number(rawPort), host, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) { stats.bytesUp += head.length; target.write(head); }
        client.on("data", (chunk) => { stats.bytesUp += chunk.length; });
        target.pipe(client); client.pipe(target);
      });
      target.on("error", () => client.destroy());
    });
    return { server, stats };
  }
  const { server: proxyServer, stats: proxyStats } = makeConnectProxy();
  const proxyPort = await listen(proxyServer); const proxyUrl = "http://127.0.0.1:" + proxyPort;
  const modules = await Promise.all([import("../../open-sse/executors/codex.js"), import("../../open-sse/executors/default.js"), import("../../open-sse/executors/antigravity.js"), import("../../open-sse/executors/muse.js"), import("../../open-sse/executors/opencode.js"), import("../../open-sse/executors/opencode-go.js"), import("../../src/lib/db/index.js"), import("../../src/sse/services/auth.js")]);
  const [{ CodexExecutor }, { DefaultExecutor }, { AntigravityExecutor }, { MuseExecutor }, { OpenCodeExecutor }, { OpenCodeGoExecutor }, db, auth] = modules;
  await db.initDb();
  const pool = await db.createProxyPool({ id: "mux-bench-proxy", name: "local CONNECT", proxyUrl, type: "http", isActive: true, strictProxy: true });
  await db.createProviderConnection({ provider: "opencode-go", authType: "apikey", name: "bench-go", apiKey: "bench", providerSpecificData: { proxyPoolId: pool.id } });
  await db.createProviderConnection({ provider: "opencode", authType: "apikey", name: "bench-free", apiKey: "public", providerSpecificData: { proxyPoolId: pool.id } });
  await db.updateSettings({ fallbackStrategy: "fill-first", providerStrategies: { opencode: { proxyPoolId: pool.id, rotateStrategy: "none" } } });
  const executors = { codex: patchExecutor(new CodexExecutor(), upstreamUrl), openrouter: patchExecutor(new DefaultExecutor("openrouter"), upstreamUrl), antigravity: patchExecutor(new AntigravityExecutor(), upstreamUrl), glm: patchExecutor(new DefaultExecutor("glm"), upstreamUrl), muse: patchExecutor(new MuseExecutor(), upstreamUrl), "opencode-go": patchExecutor(new OpenCodeGoExecutor(), upstreamUrl), opencode: patchExecutor(new OpenCodeExecutor(), upstreamUrl) };
  const baseCreds = { codex: { accessToken: "bench", providerSpecificData: {} }, openrouter: { apiKey: "bench", providerSpecificData: {} }, antigravity: { accessToken: "bench", projectId: "bench", providerSpecificData: {} }, glm: { apiKey: "bench", providerSpecificData: {} }, muse: { apiKey: "bench", providerSpecificData: { apiBaseUrl: upstreamUrl + "/v1" } } };
  async function cred(provider) {
    if (provider !== "opencode-go" && provider !== "opencode") return { credentials: baseCreds[provider], proxyOptions: null };
    const credentials = await auth.getProviderCredentials(provider, null, "benchmark-model");
    assert(credentials);
    assert.equal(credentials.providerSpecificData.connectionProxyUrl, proxyUrl);
    return { credentials: { ...credentials, connectionId: credentials.id || "bench", rawHeaders: { "x-session-id": "bench-session" } }, proxyOptions: { enabled: true, url: proxyUrl, strictProxy: true } };
  }

  const out = { mode, startedAt: new Date().toISOString(), scenarios: [] };

  if (mode === "growth") {
    // Scenario 1: single long-lived thread replayed progressively (sequential turns preserved)
    const msgs = loadSessionMessages(SOURCES.router9);
    const cps = buildCheckpoints(msgs, CHECKPOINT_TOKENS);
    for (const cp of cps) {
      const timing = [];
      const loop = monitorEventLoopDelay({ resolution: 5 }); loop.enable();
      const heapStart = process.memoryUsage().heapUsed;
      const t0 = performance.now();
      // sequential thread semantics: one turn at a time
      await runOne(executors.codex, "codex", cp.messages, ...(await cred("codex")).constructor === Object ? [ (await cred("codex")).credentials, (await cred("codex")).proxyOptions ] : [], timing);
      // hmm simplify: run multiple sequential turns for stable timing
      for (let i = 0; i < 3; i++) {
        const { credentials, proxyOptions } = await cred("codex");
        await runOne(executors.codex, "codex", cp.messages, credentials, proxyOptions, timing);
      }
      loop.disable();
      const prep = stats(timing.map((t) => t.prep));
      const ttft = stats(timing.map((t) => t.ttft));
      const total = stats(timing.map((t) => t.total));
      out.scenarios.push({ scenario: "growth", source: "router9", targetTokens: cp.targetTokens, messages: cp.messages.length, serializedBytes: Buffer.byteLength(JSON.stringify(cp.messages)), prepMs: prep, ttftMs: ttft, totalMs: total, heapDeltaMB: +((process.memoryUsage().heapUsed - heapStart) / 1048576).toFixed(1), elMeanMs: +(Number(loop.mean) / 1e6).toFixed(3), elP95Ms: +(loop.percentile(95) / 1e6).toFixed(3) });
    }
  }

  if (mode === "fanout") {
    // Scenario 2: parent + N sub-agents; parent responsiveness during fan-out
    const parentMsgs = loadSessionMessages(SOURCES.computeruse); // 241k tokens
    const childCount = Number(process.env.FANOUT_N || 8);
    const childSize = Number(process.env.FANOUT_CHILD_TOKENS || 60000);
    const childProviders = ["codex", "openrouter", "codex", "glm", "muse", "opencode-go", "openrouter", "codex", "glm", "opencode", "codex", "openrouter", "glm", "codex", "openrouter", "codex"];
    const childMsgs = Array.from({ length: childCount }, (_, i) => buildChildContext(parentMsgs, i, childCount, childSize));
    // pre-resolve creds (avoid auth in hot loop)
    const credCache = {};
    for (const p of new Set(childProviders.slice(0, childCount))) credCache[p] = await cred(p);
    credCache.codex = await cred("codex");
    // parent alone first
    const parentAlone = [];
    for (let i = 0; i < 3; i++) await runOne(executors.codex, "codex", parentMsgs, credCache.codex.credentials, credCache.codex.proxyOptions, parentAlone);
    // children + parent during active fan-out
    const fanTiming = { parent: [], children: Array.from({ length: childCount }, () => []) };
    const loop = monitorEventLoopDelay({ resolution: 5 }); loop.enable();
    const heapStart = process.memoryUsage().heapUsed;
    await Promise.all([
      ...childMsgs.map((msgs, i) => runOne(executors[childProviders[i % childProviders.length]], childProviders[i % childProviders.length], msgs, credCache[childProviders[i % childProviders.length]].credentials, credCache[childProviders[i % childProviders.length]].proxyOptions, fanTiming.children[i])),
      runOne(executors.codex, "codex", parentMsgs, credCache.codex.credentials, credCache.codex.proxyOptions, fanTiming.parent),
    ]);
    loop.disable();
    const childFlatten = fanTiming.children.flat();
    out.scenarios.push({ scenario: "fanout", source: "computeruse", parentTokens: estimateTokensOf(parentMsgs), childCount, childSize, parentAlone: stats(parentAlone.map((t) => t.ttft)), parentDuringFanout: stats(fanTiming.parent.map((t) => t.ttft)), childTtft: stats(childFlatten.map((t) => t.ttft)), childTotal: stats(childFlatten.map((t) => t.total)), heapDeltaMB: +((process.memoryUsage().heapUsed - heapStart) / 1048576).toFixed(1), elMeanMs: +(Number(loop.mean) / 1e6).toFixed(3), elP95Ms: +(loop.percentile(95) / 1e6).toFixed(3) });
  }

  if (mode === "fanin") {
    // Scenario 3: fan-in - children return results, parent grows, parent sends follow-up
    const parentMsgs = loadSessionMessages(SOURCES.computeruse);
    const childCount = 8; const childSize = 60000;
    const childMsgs = Array.from({ length: childCount }, (_, i) => buildChildContext(parentMsgs, i, childCount, childSize));
    const childProviders = ["codex", "openrouter", "codex", "glm", "muse", "opencode-go", "openrouter", "codex"];
    const credCache = {};
    for (const p of new Set(childProviders)) credCache[p] = await cred(p);
    const before = estimateTokensOf(parentMsgs);
    // run children, harvest their "results" (we simulate with fixed-size realistic report text)
    const reportChars = 40000; // ~10k tokens per child report
    const grown = [...parentMsgs];
    const t0 = performance.now();
    await Promise.all(childMsgs.map((msgs, i) => runOne(executors[childProviders[i]], childProviders[i], msgs, credCache[childProviders[i]].credentials, credCache[childProviders[i]].proxyOptions, [])));
    const childPhase = performance.now() - t0;
    for (let i = 0; i < childCount; i++) {
      grown.push({ role: "user", content: "Sub-agent " + (i + 1) + " report: " + "Analysis complete. Files inspected, call chains traced, no regressions found. ".repeat(Math.ceil(reportChars / 63)) });
    }
    const after = estimateTokensOf(grown);
    const timing = [];
    for (let i = 0; i < 3; i++) await runOne(executors.codex, "codex", grown, credCache.codex.credentials, credCache.codex.proxyOptions, timing);
    out.scenarios.push({ scenario: "fanin", parentTokensBefore: before, parentTokensAfter: after, childPhaseMs: +childPhase.toFixed(1), followUpPrepMs: stats(timing.map((t) => t.prep)), followUpTtftMs: stats(timing.map((t) => t.ttft)), followUpTotalMs: stats(timing.map((t) => t.total)) });
  }

  if (mode === "multiproject") {
    // Scenario 4: multiple independent projects concurrently + small victim probe
    const projDefs = JSON.parse(process.env.PROJ_DEFS || "[]");
    if (!projDefs.length) throw new Error("PROJ_DEFS required");
    const loaded = projDefs.map((d) => ({ ...d, msgs: loadSessionMessages(SOURCES[d.source]) }));
    for (const d of loaded) {
      if (d.maxTokens && estimateTokensOf(d.msgs) > d.maxTokens) d.msgs = d.msgs.slice(0, findMsgIdx(d.msgs, d.maxTokens));
    }
    const providers = ["codex", "openrouter", "antigravity", "glm", "muse", "opencode-go", "opencode"];
    const credCache = {};
    for (const p of providers) credCache[p] = await cred(p);
    const victimMsgs = [{ role: "system", content: "short" }, { role: "user", content: "say ok" }];
    const victims = [];
    let running = true;
    const victimLoop = (async () => {
      while (running) {
        const t = [];
        await runOne(executors.openrouter, "openrouter", victimMsgs, credCache.openrouter.credentials, null, t);
        victims.push(t[0].ttft);
        await sleep(Number(process.env.VICTIM_INTERVAL_MS || 150));
      }
    })();
    const loop = monitorEventLoopDelay({ resolution: 5 }); loop.enable();
    const heapStart = process.memoryUsage().heapUsed;
    const rssStart = process.memoryUsage().rss;
    await Promise.all(loaded.map((d) => (async () => {
      for (let turn = 0; turn < (d.turns || 2); turn++) {
        // sequential per-project thread semantics
        await runOne(executors[d.provider], d.provider, d.msgs, credCache[d.provider].credentials, credCache[d.provider].proxyOptions, []);
        if (d.children) {
          await Promise.all(Array.from({ length: d.children }, (_, i) => {
            const childMsgs = buildChildContext(d.msgs, i, d.children, d.childTokens || 50000);
            const cp = d.childProvider || "openrouter";
            return runOne(executors[cp], cp, childMsgs, credCache[cp].credentials, credCache[cp].proxyOptions, []);
          }));
        }
      }
    })()));
    running = false;
    await victimLoop;
    loop.disable();
    out.scenarios.push({ scenario: "multiproject", projects: projDefs, victims: stats(victims), victimCount: victims.length, elMeanMs: +(Number(loop.mean) / 1e6).toFixed(3), elP95Ms: +(loop.percentile(95) / 1e6).toFixed(3), heapDeltaMB: +((process.memoryUsage().heapUsed - heapStart) / 1048576).toFixed(1), rssDeltaMB: +((process.memoryUsage().rss - rssStart) / 1048576).toFixed(1) });
  }

  if (mode === "victim-scale") {
    // Scenario 5: small victim probe vs 0/1/2/4/8 heavy projects with realistic duration
    const parent = loadSessionMessages(SOURCES.computeruse);
    const credCache = { openrouter: await cred("openrouter"), codex: await cred("codex"), glm: await cred("glm"), antigravity: await cred("antigravity") };
    const victimMsgs = [{ role: "system", content: "short" }, { role: "user", content: "say ok" }];
    for (const nHeavy of [0, 1, 2, 4, 8]) {
      const victims = [];
      let running = true;
      const victimLoop = (async () => {
        while (running) {
          const t = [];
          await runOne(executors.openrouter, "openrouter", victimMsgs, credCache.openrouter.credentials, null, t);
          victims.push(t[0].ttft);
          await sleep(50);
        }
      })();
      const deadline = Date.now() + 2500; // 2.5s window per tier
      if (nHeavy > 0) {
        // circulate N heavy workers concurrently for 2.5s
        await Promise.all(Array.from({ length: nHeavy }, async (_, i) => {
          const providers = ["codex", "glm", "antigravity", "openrouter"];
          const p = providers[i % 4];
          while (Date.now() < deadline) {
            await runOne(executors[p], p, parent, credCache[p].credentials, credCache[p].proxyOptions, []);
          }
        }));
      } else {
        await sleep(2500);
      }
      running = false;
      await victimLoop;
      out.scenarios.push({ scenario: "victim-scale", heavyProjects: nHeavy, victims: stats(victims), victimCount: victims.length });
    }
  }

  if (mode === "stream") {
    // long-stream scenarios on dedicated upstream
    const ls = makeLongStreamUpstream(keyFile, certFile, { chunks: Number(process.env.STREAM_CHUNKS || 2000), chunkBytes: Number(process.env.STREAM_CHUNK_BYTES || 400) });
    const port = await listen(ls.server);
    const lsUrl = "https://127.0.0.1:" + port;
    const lsExecutors = { codex: patchExecutor(new CodexExecutor(), lsUrl), openrouter: patchExecutor(new DefaultExecutor("openrouter"), lsUrl) };
    const credCache = { codex: await cred("codex"), openrouter: await cred("openrouter") };
    const parent = loadSessionMessages(SOURCES.computeruse);
    for (const nStreams of [1, 10, 25]) {
      const timing = [];
      const loop = monitorEventLoopDelay({ resolution: 5 }); loop.enable();
      await Promise.all(Array.from({ length: nStreams }, (_, i) => runOne(lsExecutors[i % 2 ? "openrouter" : "codex"], i % 2 ? "openrouter" : "codex", parent, credCache[i % 2 ? "openrouter" : "codex"].credentials, null, timing)));
      loop.disable();
      out.scenarios.push({ scenario: "stream", nStreams, chunks: Number(process.env.STREAM_CHUNKS || 2000), chunkBytes: Number(process.env.STREAM_CHUNK_BYTES || 400), ttftMs: stats(timing.map((t) => t.ttft)), streamMs: stats(timing.map((t) => t.stream)), totalMs: stats(timing.map((t) => t.total)), elP95Ms: +(loop.percentile(95) / 1e6).toFixed(3) });
    }
    await close(ls.server);
  }

  out.proxy = { connects: proxyStats.connects };
  out.upstreamRequests = upstream.stats.requests;
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  await close(upstream.server); await close(proxyServer);
  fs.rmSync(temp, { recursive: true, force: true });
}

function estimateTokensOf(msgs) { return msgs.reduce((a, m) => a + estimateTokens(m.content || ""), 0); }
function findMsgIdx(msgs, maxTokens) { let acc = 0; for (let i = 0; i < msgs.length; i++) { acc += estimateTokens(msgs[i].content || ""); if (acc > maxTokens) return i; } return msgs.length; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((error) => { console.error(error); process.exitCode = 1; });
