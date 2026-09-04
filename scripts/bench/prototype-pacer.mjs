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

// Global timeline state for prototype pacer
let currentPolicy = { type: "baseline", thresholdBytes: 262144 };
let nextAdmissionAt = 0;

export function resetPacer(policy) {
  currentPolicy = policy;
  nextAdmissionAt = 0;
}

export async function prototypePacerBeforeUpload(actualBytes, signal) {
  if (currentPolicy.type === "baseline") return 0;
  if (actualBytes < currentPolicy.thresholdBytes) return 0;
  if (signal?.aborted) throw signal.reason || new Error("Aborted");

  const now = performance.now();
  if (!Number.isFinite(nextAdmissionAt)) {
    nextAdmissionAt = now;
  }
  const scheduledAt = Math.max(now, nextAdmissionAt);

  let spacing = 0;
  if (currentPolicy.type === "fixed") {
    spacing = currentPolicy.spacingMs;
  } else if (currentPolicy.type === "byte-weighted") {
    // 8ms per MB, clamped between 5ms and 15ms
    spacing = Math.min(15, Math.max(5, (actualBytes / 1048576) * 8));
  }

  nextAdmissionAt = scheduledAt + spacing;
  const waitMs = scheduledAt - now;
  if (waitMs > 0) {
    await new Promise((resolve, reject) => {
      let timer = null;
      const onAbort = () => {
        if (timer) clearTimeout(timer);
        reject(signal.reason || new Error("Aborted"));
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve();
      }, waitMs);
    });
  }
  return waitMs;
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

async function runInstrumentedVictim(executor, provider, messages, creds, proxyOptions, auth, db) {
  const tArrival = performance.now();
  let tHandler = performance.now();
  await new Promise((r) => setImmediate(() => { tHandler = performance.now(); r(); }));
  const schedulingDelay = tHandler - tArrival;

  const tAuth0 = performance.now();
  const credentials = await auth.getProviderCredentials(provider, null, "benchmark-model");
  const authWait = performance.now() - tAuth0;

  const tPrep0 = performance.now();
  const { transformedBody, ctx, bodyStr } = await executor.prepareRequest({
    model: "benchmark-model",
    body: { model: "benchmark-model", stream: true, messages },
    stream: true,
    credentials,
    requestId: "bench"
  });
  const localPrep = performance.now() - tPrep0;

  const tFetch0 = performance.now();
  const { response } = await executor.execute({
    model: "benchmark-model",
    body: { model: "benchmark-model", stream: true, messages },
    stream: true,
    credentials,
    preparedRequest: { transformedBody, ctx, bodyStr },
    log: { debug() {}, warn() {}, info() {}, error() {} }
  });
  const fetchTime = performance.now() - tFetch0;

  const tFc0 = performance.now();
  const reader = response.body.getReader();
  await reader.read();
  const firstChunkWait = performance.now() - tFc0;
  while (!(await reader.read()).done) {}
  const totalStream = performance.now() - tArrival;

  return {
    schedulingDelay: +schedulingDelay.toFixed(2),
    authWait: +authWait.toFixed(2),
    localPrep: +localPrep.toFixed(2),
    fetchTime: +fetchTime.toFixed(2),
    firstChunkWait: +firstChunkWait.toFixed(2),
    totalTtft: +(schedulingDelay + authWait + localPrep + fetchTime + firstChunkWait).toFixed(2),
    totalStream: +totalStream.toFixed(2)
  };
}

async function runHeavy(executor, provider, messages, creds) {
  const body = { model: provider === "antigravity" ? "gemini-2.5-pro" : "benchmark-model", stream: true, messages };
  const { response } = await executor.execute({
    model: body.model,
    body,
    stream: true,
    credentials: creds,
    log: { debug() {}, warn() {}, info() {}, error() {} }
  });
  const reader = response.body.getReader();
  while (!(await reader.read()).done) {}
}

async function main() {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "9router-proto-"));
  process.env.DATA_DIR = path.join(temp, "data");
  fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
  const keyFile = path.join(temp, "key.pem");
  const certFile = path.join(temp, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=127.0.0.1", "-keyout", keyFile, "-out", certFile, "-days", "1"], { stdio: "ignore" });

  const upstream = await startUpstreamChild(keyFile, certFile);
  const victimUpstream = await startUpstreamChild(keyFile, certFile);

  const [
    { BaseExecutor },
    { CodexExecutor },
    { DefaultExecutor },
    { AntigravityExecutor },
    { MuseExecutor },
    db,
    auth
  ] = await Promise.all([
    import("open-sse/executors/base.js"),
    import("open-sse/executors/codex.js"),
    import("open-sse/executors/default.js"),
    import("open-sse/executors/antigravity.js"),
    import("open-sse/executors/muse.js"),
    import("@/lib/db/index.js"),
    import("@/sse/services/auth.js")
  ]);

  await db.initDb();
  db.createProviderConnection({ provider: "openrouter", authType: "apikey", name: "bench-openrouter", apiKey: "bench-key" });

  // Hook BaseExecutor.prototype.execute to run prototype pacer immediately before physical dispatch
  const origExecute = BaseExecutor.prototype.execute;
  BaseExecutor.prototype.execute = async function(args) {
    // If preparedRequest was already calculated, read bodyStr length, else calculate
    const { transformedBody, ctx, bodyStr } = args.preparedRequest || (await this.prepareRequestFair(args));
    if (bodyStr) {
      const actualBytes = Buffer.byteLength(bodyStr, "utf8");
      await prototypePacerBeforeUpload(actualBytes, args.signal);
    }
    return origExecute.call(this, { ...args, preparedRequest: { transformedBody, ctx, bodyStr } });
  };

  const executors = {
    codex: patchExecutor(new CodexExecutor(), upstream.url),
    openrouter: patchExecutor(new DefaultExecutor("openrouter"), upstream.url),
    antigravity: patchExecutor(new AntigravityExecutor(), upstream.url),
    glm: patchExecutor(new DefaultExecutor("glm"), upstream.url),
    muse: patchExecutor(new MuseExecutor(), upstream.url)
  };
  const baseCreds = {
    codex: { accessToken: "k", providerSpecificData: {} },
    openrouter: { apiKey: "bench-key" },
    antigravity: { accessToken: "k", projectId: "p", providerSpecificData: {} },
    glm: { apiKey: "k" },
    muse: { accessToken: "k", providerSpecificData: {} }
  };

  const victimExec = patchExecutor(new DefaultExecutor("openrouter"), victimUrl(victimUpstream));
  const victimMsgs = [{ role: "user", content: "ping" }];
  const pComputerUse = loadSessionMessages(SOURCES.computeruse);

  function victimUrl(u) { return u.url; }

  // Define candidate policies to evaluate
  const candidatePolicies = [
    { name: "Baseline", type: "baseline", thresholdBytes: 262144 },
    { name: "Fixed-5ms-256KB", type: "fixed", spacingMs: 5, thresholdBytes: 262144 },
    { name: "Fixed-10ms-256KB", type: "fixed", spacingMs: 10, thresholdBytes: 262144 },
    { name: "Fixed-15ms-256KB", type: "fixed", spacingMs: 15, thresholdBytes: 262144 },
    { name: "Byte-Weighted-256KB", type: "byte-weighted", thresholdBytes: 262144 },
    // Threshold variants for 10ms
    { name: "Fixed-10ms-128KB", type: "fixed", spacingMs: 10, thresholdBytes: 131072 },
    { name: "Fixed-10ms-512KB", type: "fixed", spacingMs: 10, thresholdBytes: 524288 }
  ];

  const policyResults = [];

  for (const pol of candidatePolicies) {
    resetPacer(pol);

    // 1. Workload A: 8 Heavy Projects + Victim Probe
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
    let heavyCount = 0;
    const tBatch0 = performance.now();
    await Promise.all(Array.from({ length: 8 }, async (_, i) => {
      const p = ["codex", "glm", "antigravity", "openrouter"][i % 4];
      while (Date.now() < deadline) {
        await runHeavy(executors[p], p, pComputerUse, baseCreds[p]);
        heavyCount++;
      }
    }));
    const batchWall = performance.now() - tBatch0;

    running = false;
    await victimLoop;
    loop.disable();

    const victimTtft = stats(stageSamples.map((s) => s.totalTtft));
    const victimFetch = stats(stageSamples.map((s) => s.fetchTime));

    // 2. Workload B: Fan-out burst (16 simultaneous heavy requests)
    resetPacer(pol);
    const burstStart = performance.now();
    const childTtfts = [];
    await Promise.all(Array.from({ length: 16 }, async (_, i) => {
      const p = ["codex", "glm", "antigravity", "openrouter"][i % 4];
      const t0 = performance.now();
      await runHeavy(executors[p], p, pComputerUse, baseCreds[p]);
      childTtfts.push(performance.now() - t0);
    }));
    const burstWall = performance.now() - burstStart;
    const fanoutStats = stats(childTtfts);

    // 3. Workload E: Burst Scaling (50 requests admission backlog test)
    resetPacer(pol);
    const burst50Start = performance.now();
    const waitTimes = [];
    await Promise.all(Array.from({ length: 50 }, async (_, i) => {
      const p = ["codex", "glm", "antigravity", "openrouter"][i % 4];
      const t0 = performance.now();
      await runHeavy(executors[p], p, pComputerUse, baseCreds[p]);
      waitTimes.push(performance.now() - t0);
    }));
    const burst50Wall = performance.now() - burst50Start;
    const waitStats = stats(waitTimes);

    policyResults.push({
      policy: pol.name,
      threshold: pol.thresholdBytes / 1024 + "KB",
      victimP50: victimTtft.p50,
      victimP95: victimTtft.p95,
      victimP99: victimTtft.p99,
      victimFetchP50: victimFetch.p50,
      fanoutP50: fanoutStats.p50,
      fanoutP95: fanoutStats.p95,
      fanoutWallMs: +burstWall.toFixed(1),
      burst50WallMs: +burst50Wall.toFixed(1),
      burst50MaxWait: waitStats.max,
      batchRps: +((heavyCount / (batchWall / 1000))).toFixed(1),
      elP95: +(loop.percentile(95) / 1e6).toFixed(2)
    });
  }

  process.stdout.write("PROTOTYPE_PACER_RESULTS_START\n");
  process.stdout.write(JSON.stringify(policyResults, null, 2));
  process.stdout.write("\nPROTOTYPE_PACER_RESULTS_END\n");

  upstream.child.kill();
  victimUpstream.child.kill();
  fs.rmSync(temp, { recursive: true, force: true });
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
