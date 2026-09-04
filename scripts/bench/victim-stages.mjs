// Stage-level breakdown of a Small Victim Request under 0, 1, 2, 4, 8 heavy projects.
// Upstream runs in a CHILD PROCESS so server-side TLS work cannot contaminate victim timings.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { loadSessionMessages } from "./mux-fixtures.mjs";

const HOME = os.homedir();
const SOURCES = {
  mux: HOME + "/.mux/sessions/6d189e8a9d/chat.jsonl",
  computeruse: HOME + "/.mux/sessions/e8cf0d0b8f/chat.jsonl",
};

function stats(arr) {
  if (!arr.length) return { p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const s = [...arr].sort((a, b) => a - b);
  const pick = (p) => +s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)].toFixed(2);
  return { p50: pick(0.5), p95: pick(0.95), p99: pick(0.99), max: +Math.max(...arr).toFixed(2), mean: +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) };
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

// Detailed stage-instrumented execution for victim request
async function runInstrumentedVictim(executor, provider, messages, creds, proxyOptions, auth, db) {
  const tArrival = performance.now();

  // 1. Scheduling delay: event-loop queue delay before handler picks up task
  let tHandler = performance.now();
  await new Promise((r) => setImmediate(() => { tHandler = performance.now(); r(); }));
  const schedulingDelay = tHandler - tArrival;

  // 2. Auth / account selection
  const tAuth0 = performance.now();
  const credentials = await auth.getProviderCredentials(provider, null, "benchmark-model");
  const authWait = performance.now() - tAuth0;

  // 3. Local preparation (transform + JSON.stringify)
  const tPrep0 = performance.now();
  const { transformedBody, ctx, bodyStr } = await executor.prepareRequest({ model: "benchmark-model", body: { model: "benchmark-model", stream: true, messages }, stream: true, credentials, requestId: "bench" });
  const localPrep = performance.now() - tPrep0;

  // 4. Fetch (undici dispatcher acquisition + socket write + upload + first byte)
  const tFetch0 = performance.now();
  const { response } = await executor.execute({ model: "benchmark-model", body: { model: "benchmark-model", stream: true, messages }, stream: true, credentials, preparedRequest: { transformedBody, ctx, bodyStr }, log: { debug() {}, warn() {}, info() {}, error() {} } });
  const fetchTime = performance.now() - tFetch0;
  const upstreamUploadMs = Number(response.headers?.get?.("x-upload-ms") || 0);

  // 5. First chunk
  const tFc0 = performance.now();
  const reader = response.body.getReader();
  const first = await reader.read();
  const firstChunkWait = performance.now() - tFc0;
  while (!(await reader.read()).done) {}
  const totalStream = performance.now() - tArrival;

  return {
    schedulingDelay: +schedulingDelay.toFixed(2),
    authWait: +authWait.toFixed(2),
    localPrep: +localPrep.toFixed(2),
    fetchTime: +fetchTime.toFixed(2),
    upstreamUploadMs: +upstreamUploadMs.toFixed(2),
    firstChunkWait: +firstChunkWait.toFixed(2),
    totalTtft: +(schedulingDelay + authWait + localPrep + fetchTime + firstChunkWait).toFixed(2),
    totalStream: +totalStream.toFixed(2)
  };
}

async function runHeavy(executor, provider, messages, creds) {
  const body = { model: provider === "antigravity" ? "gemini-2.5-pro" : "benchmark-model", stream: true, messages };
  const { response } = await executor.execute({ model: body.model, body, stream: true, credentials: creds, log: { debug() {}, warn() {}, info() {}, error() {} } });
  const reader = response.body.getReader();
  while (!(await reader.read()).done) {}
}

async function startUpstreamChild(keyFile, certFile) {
  const child = spawn("node", ["scripts/bench/upstream-child.mjs", keyFile, certFile], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("upstream child did not report port")), 10000);
    child.stdout.on("data", (d) => {
      buf += d.toString();
      const m = buf.match(/\d+/);
      if (m) { clearTimeout(timer); resolve(Number(m[0])); }
    });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error("upstream child exited early code=" + code)); });
  });
  return { child, port, url: "https://127.0.0.1:" + port };
}

async function main() {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "9router-stages-"));
  process.env.DATA_DIR = path.join(temp, "data");
  fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
  const keyFile = path.join(temp, "key.pem");
  const certFile = path.join(temp, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=127.0.0.1", "-keyout", keyFile, "-out", certFile, "-days", "1"], { stdio: "ignore" });

  const upstream = await startUpstreamChild(keyFile, certFile);
  const upstreamUrl = upstream.url;
  // Separate IDLE upstream for the victim: isolates gateway-side (client) interference
  // from server-side busy-decrypt artifacts of the shared heavy upstream.
  const victimUpstream = await startUpstreamChild(keyFile, certFile);
  const victimUrl = victimUpstream.url;

  const modules = await Promise.all([
    import("../../open-sse/executors/codex.js"),
    import("../../open-sse/executors/default.js"),
    import("../../open-sse/executors/antigravity.js"),
    import("../../open-sse/executors/muse.js"),
    import("../../src/lib/db/index.js"),
    import("../../src/sse/services/auth.js")
  ]);
  const [{ CodexExecutor }, { DefaultExecutor }, { AntigravityExecutor }, { MuseExecutor }, db, auth] = modules;
  await db.initDb();
  db.createProviderConnection({ provider: "openrouter", authType: "apikey", name: "bench-openrouter", apiKey: "bench-key" });

  const executors = {
    codex: patchExecutor(new CodexExecutor(), upstreamUrl),
    openrouter: patchExecutor(new DefaultExecutor("openrouter"), upstreamUrl),
    antigravity: patchExecutor(new AntigravityExecutor(), upstreamUrl),
    glm: patchExecutor(new DefaultExecutor("glm"), upstreamUrl),
    muse: patchExecutor(new MuseExecutor(), upstreamUrl)
  };
  const baseCreds = { codex: { accessToken: "k", providerSpecificData: {} }, openrouter: { apiKey: "bench-key" }, antigravity: { accessToken: "k", projectId: "p", providerSpecificData: {} }, glm: { apiKey: "k" }, muse: { accessToken: "k", providerSpecificData: {} } };

  const victimExec = patchExecutor(new DefaultExecutor("openrouter"), victimUrl);
  const victimMsgs = [{ role: "user", content: "ping" }];
  const pComputerUse = loadSessionMessages(SOURCES.computeruse);
  const results = [];

  const levels = process.env.BENCH_HEAVY_LEVELS ? process.env.BENCH_HEAVY_LEVELS.split(",").map(Number) : [0, 1, 2, 4, 8];
  for (const nHeavy of levels) {
    const stageSamples = [];
    let running = true;
    const loop = monitorEventLoopDelay({ resolution: 5 });
    loop.enable();

    const victimLoop = (async () => {
      while (running) {
        const s = await runInstrumentedVictim(victimExec, "openrouter", victimMsgs, baseCreds.openrouter, null, auth, db);
        stageSamples.push(s);
        await new Promise((r) => setTimeout(r, 60));
      }
    })();

    const deadline = Date.now() + 3000;
    if (nHeavy > 0) {
      await Promise.all(Array.from({ length: nHeavy }, async (_, i) => {
        const p = ["codex", "glm", "antigravity", "openrouter"][i % 4];
        while (Date.now() < deadline) {
          await runHeavy(executors[p], p, pComputerUse, baseCreds[p]);
        }
      }));
    } else {
      await new Promise((r) => setTimeout(r, 3000));
    }

    running = false;
    await victimLoop;
    loop.disable();

    results.push({
      heavyProjects: nHeavy,
      sampleCount: stageSamples.length,
      ttft: stats(stageSamples.map((s) => s.totalTtft)),
      scheduling: stats(stageSamples.map((s) => s.schedulingDelay)),
      auth: stats(stageSamples.map((s) => s.authWait)),
      localPrep: stats(stageSamples.map((s) => s.localPrep)),
      fetch: stats(stageSamples.map((s) => s.fetchTime)),
      firstChunk: stats(stageSamples.map((s) => s.firstChunkWait)),
      upstreamUpload: stats(stageSamples.map((s) => s.upstreamUploadMs)),
      eventLoopLag: {
        mean: +(Number(loop.mean) / 1e6).toFixed(2),
        p95: +(loop.percentile(95) / 1e6).toFixed(2),
        max: +(loop.max / 1e6).toFixed(2)
      }
    });
  }

  process.stdout.write("RESULTS_JSON_START\n");
  process.stdout.write(JSON.stringify(results, null, 2));
  process.stdout.write("\nRESULTS_JSON_END\n");
  upstream.child.kill();
  victimUpstream.child.kill();
  fs.rmSync(temp, { recursive: true, force: true });
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
