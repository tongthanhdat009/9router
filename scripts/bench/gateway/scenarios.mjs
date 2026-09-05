// Sequential scenario runners inside ONE gateway process launch per policy.
// Every sample passes through strict validateSse (inside ctx.post); heavy legs
// carry sorted-key semantic sha256 reconciliation. Raw data only, no claims.
import { createHash } from 'node:crypto';

export const canon = (o) => Array.isArray(o) ? '[' + o.map(canon).join(',') + ']' : (o && typeof o === 'object') ? '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + canon(o[k])).join(',') + '}' : JSON.stringify(o);

// ctx: { post(model,messages?), get(path), reset(), summary, key, model, heavyMessages }
// post(model, messages) -> validated sample; get(path) -> parsed JSON; reset() -> upstream counters zeroed.
export async function runSmallC1(ctx, n = 10) {
  const samples = [];
  for (let i = 0; i < n; i++) samples.push(await ctx.post(ctx.model));
  const ok = samples.filter(s => !s.error);
  return { name: 'small-c1', n, errors: samples.length - ok.length, ttft: ctx.summary(ok.map(s => s.firstByteMs)), total: ctx.summary(ok.map(s => s.totalMs)) };
}

export async function runHeavySingle(ctx) {
  await ctx.reset();
  const heavy = await ctx.post(ctx.model, ctx.heavyMessages);
  const stats = await ctx.get('/__stats');
  // Verified model-prefix rewrite (chatCore.js:103 getModelUpstreamId + :202
  // stripThinkingSuffix): routed bench/benchmark-model serializes as benchmark-model.
  const clientBody = JSON.parse(JSON.stringify({ model: ctx.model, stream: true, messages: ctx.heavyMessages }));
  const expectedUpstream = { ...clientBody, model: 'benchmark-model' };
  const expectedUpstreamBytes = Buffer.byteLength(JSON.stringify(expectedUpstream));
  const expectedCanonicalSha256 = createHash('sha256').update(canon(expectedUpstream)).digest('hex');
  return {
    name: 'heavy-single-300k', messages: ctx.heavyMessages.length, clientBodyBytes: heavy.clientBodyBytes,
    upstreamReceivedBytes: stats.bytesReceived, upstreamRequests: stats.requests,
    modelRewriteBytes: heavy.clientBodyBytes - stats.bytesReceived,
    bytesReconciled: stats.bytesReceived === expectedUpstreamBytes, expectedUpstreamBytes,
    upstreamModel: stats.last?.model, upstreamCanonicalSha256: stats.last?.canonicalSha256,
    expectedCanonicalSha256, semanticReconciled: stats.last?.canonicalSha256 === expectedCanonicalSha256,
    firstByteMs: heavy.firstByteMs, totalMs: heavy.totalMs, doneVisible: heavy.doneVisible,
  };
}

export async function runHeavyConcurrent(ctx, n = 8) {
  await ctx.reset();
  const t0 = performance.now();
  const settled = await Promise.allSettled(Array.from({ length: n }, () => ctx.post(ctx.model, ctx.heavyMessages)));
  const wallMs = performance.now() - t0;
  const ok = settled.filter(s => s.status === 'fulfilled').map(s => s.value);
  const errors = settled.filter(s => s.status === 'rejected').map(s => String(s.reason?.message || s.reason));
  const stats = await ctx.get('/__stats');
  const one = JSON.parse(JSON.stringify({ model: ctx.model, stream: true, messages: ctx.heavyMessages }));
  const expectedOneBytes = Buffer.byteLength(JSON.stringify({ ...one, model: 'benchmark-model' }));
  const ttft = ok.length ? ctx.summary(ok.map(s => s.firstByteMs)) : null;
  const total = ok.length ? ctx.summary(ok.map(s => s.totalMs)) : null;
  return {
    name: 'heavy-concurrent', n, wallMs, ok: ok.length, errors,
    ttft, total, upstreamRequests: stats.requests,
    batchBytesReconciled: stats.bytesReceived === expectedOneBytes * ok.length,
    expectedBatchBytes: expectedOneBytes * ok.length, upstreamReceivedBytes: stats.bytesReceived,
  };
}

export async function runFanoutBurst(ctx, n = 16) {
  const t0 = performance.now();
  const settled = await Promise.allSettled(Array.from({ length: n }, () => ctx.post(ctx.model)));
  const wallMs = performance.now() - t0;
  const ok = settled.filter(s => s.status === 'fulfilled').map(s => s.value);
  const errors = settled.filter(s => s.status === 'rejected').map(s => String(s.reason?.message || s.reason));
  return { name: 'fanout-burst', n, wallMs, ok: ok.length, errors, ttft: ok.length ? ctx.summary(ok.map(s => s.firstByteMs)) : null };
}

// Victim = small request latency while L heavies are in flight. Rounds relaunch
// heavies so load is present for most samples; per-sample heaviesInFlight is
// exact (completion counter), not estimated.
export async function runVictimProbes(ctx, levels = [0, 1, 2, 4, 8], perLevel = 100, roundSize = 20) {
  const out = {};
  for (const L of levels) {
    const samples = [];
    let levelError = null;
    for (let done = 0; done < perLevel && !levelError; done += roundSize) {
      let finished = 0;
      const heavies = L === 0 ? [] : Array.from({ length: L }, () =>
        ctx.post(ctx.model, ctx.heavyMessages).then(r => ({ ok: true, r }), e => ({ ok: false, error: String(e?.message || e) })).finally(() => { finished++; }));
      for (let i = 0; i < roundSize; i++) {
        const heaviesInFlight = L - finished;
        try {
          const s = await ctx.post(ctx.model);
          samples.push({ firstByteMs: s.firstByteMs, totalMs: s.totalMs, heaviesLaunched: L, heaviesInFlight });
        } catch (e) { samples.push({ error: String(e?.message || e), heaviesLaunched: L, heaviesInFlight }); }
      }
      const hres = await Promise.all(heavies);
      const herr = hres.find(h => !h.ok);
      if (herr) levelError = 'heavy failed: ' + herr.error;
    }
    const ok = samples.filter(s => !s.error);
    const loaded = ok.filter(s => s.heaviesInFlight > 0);
    out[L] = {
      n: samples.length, errors: samples.length - ok.length, levelError,
      loadedSamples: loaded.length,
      ttft: ok.length ? ctx.summary(ok.map(s => s.firstByteMs)) : null,
      ttftLoaded: loaded.length ? ctx.summary(loaded.map(s => s.firstByteMs)) : null,
    };
  }
  return { name: 'victim-probes', perLevel, levels: out };
}
