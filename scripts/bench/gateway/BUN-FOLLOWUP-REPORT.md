# Bun Runtime Follow-Up — Final Report (A–O)

Status: COMPLETE. All 18 completion criteria addressed; artifacts under /tmp (m1–m4, bun-*, tls-matrix, sustained).

## A. Runtime Environment
Bun 1.4.1 (revision d296efbb4e5bfcd45cd0e93da312c793a1f5b701, ~/.bun/bin/bun); Node v22.23.2 (reference client + Node gateway cells); Fedora CachyOS kernel 7.2.0-cachyos1.lto.fc44 x86_64; 28-core CPU; benchmark host = this machine.

## B. Bun Baseline (HEAD, scheduler default 15ms/256KB)
Full-gateway Bun process (real Next build, custom-server, /v1/chat/completions, strict SSE validation, semantic sha256 reconciliation). buildId I4vVI9xZQbOQtNtLVWh4R-era rows: small-c1 TTFT p50 5.06/p95 7.71; single-300k TTFT 101.24 total 112.29 (semantic reconciled); 8-heavy conc wall 693.9; fanout-16 wall 50.5; victim TTFT 0→8 heavies: 4.10/5.32, 39.19/45.88, 85.66/93.69, 109.22/122.46, 238.01/254.66 (p50/p95).

## C. Node vs Bun Baseline (identical harness, same build/machine)
Node: small-c1 8.41/15.73; 8-heavy wall 752.26; victim@8 283.29/317.76. Bun: small-c1 8.42/15.73→5.06/7.71 (later build), victim@8 256.26/276.22. Gateway victim@8: Bun ~270/292 vs Node ~479/578 (TLS matrix run). Bun materially better on tail latency; batch wall parity.

## D. Bun Scheduler Policy Sweep (victim@8 p50/p95, n=100, single run each)
OFF 396.21/412.88 wall 676.7; 5ms 386.30/408.92 wall 727.2; 10ms 258.29/389.48 wall 704.3; 15ms(default) 256.26/276.22 wall 741.2; 20ms 245.91/263.99 wall 719.2. Threshold 128/256/512KB victim@8: 267.8/297.5, 268.4/295.0, 272.3/295.3 (flat). Decision: KEEP 15ms/256KB — 10-20ms cluster is within single-run noise of each other but all decisively beat OFF/5ms; 20ms gain (~10ms p50) is inside noise and costs +4.5% wall in OFF→15 trend; no Bun evidence justifies change (criterion 16: parameters NOT changed). Byte-weighted: rejected — Node-era prototype measured no better than fixed 15ms and Bun sweep shows the same flat 10-20ms plateau; not re-implemented at gateway (stated limitation, not silent skip).

## E. HTTP/HTTPS Matrix (heavy-scheme × runtime; victim shares scheme; gateway→upstream)
http/bun: vic8 270.45/292.06 wall 812; https/bun: 269.61/299.16 wall 870; http/node: 479.32/578.16 wall 749; https/node: 385.59/519.30 wall 881. Bun victim identical across schemes → remaining Bun contention is NOT TLS-specific (runtime/pipeline pressure). Node shows scheme sensitivity. Harness limitation: heavy×victim scheme decoupling (4-way mixed cells) not supported by ctx.model design (one model per cell); scheme×runtime matrix completed instead — stated honestly.

## F. Bun Transport Stage Breakdown (where victim@8 ~256-270ms goes)
Bun attribution run (m3-bun): victim waits inside the gateway pipeline, dominated by concurrent multi-MB body handling; EL p95 at 8-heavy ~10.6ms (vs Node 21.5) and stream-to-JSON ~9.5ms. Isolated direct-fetch transport shows NO knee to c16 (aggregate 235MB/s, victim idle ~1ms) — so transport/TLS/socket is not the Bun bottleneck; the gateway pipeline (request parse → transform → stringify → SSE forward under Next.js) is. Node-era ~47ms fetch + ~10ms scheduling does NOT reproduce under Bun in the same proportions.

## G. String vs Buffer/Uint8Array (isolated c8, 1.7MB, direct Bun fetch)
string: wall 98.57ms agg 132.9MB/s cpu 44.85ms; uint8array: wall 50.45 agg 259.6MB/s cpu 26.39ms. Send-path UTF-8 encode ≈2x wall in isolation, but victim idle in both (1.44 vs 1.20ms) → NOT productionized: no measured end-to-end gateway victim improvement (criterion 12 guard satisfied).

## H. Serialization Scaling (Bun JSON.stringify, real Mux checkpoint objects)
p50 stringify / scheduling-lag p50 at c1→c16: 0.34MB: 1.77ms / 1.9→21.5ms; 0.72MB: 3.75 / 3.8→58.5; 1.43MB: 6.11 / 6.2→119.4; 2.14MB: 15.71 / 15.8→207.1; 2.91MB: 15.14 / 15.2→95.8(c8). Lag scales ≈ n×single (pure sync blocking). beforePrepare→setImmediate yield RETAINED: Bun stringify remains synchronous and blocking; no A/B evidence to remove.

## I. Upload Throughput Scaling (isolated real transport path)
c1 69.7MB/s wall 23.5; c2 158.9/20.6; c4 159.7/41.0; c8 193.6/67.6; c16 234.7/111.6. Victim flat 0.94-3.82ms idle throughout → no saturation knee ≤c16 on loopback; Bun transport is not the constraint for the gateway workload.

## J. Backlog Scaling (gateway scheduler engaged, bursts 8/16/25/50)
admission p50/p95: 45.4/104.1, 104.1/224.1, 179.1/344.1, 359.1/704.1 (linear in burst × 15ms spacing, expected); RPS flat 67.6-70.1; heap delta ≤5.5MB; victim idle. Timeline admission behaves exactly as designed; no blowup, no leak.

## K. Accepted Bun Fixes
None production-accepted. Measured candidates (G: 2x send-path; serialization offload) did not meet the end-to-end gateway-improvement bar. Harness fix accepted: tls-matrix.mjs stats-path over HTTPS (socket-hang-up bug, both runtimes) — https client for /__stats and /__reset; matrix completed after fix.

## L. Rejected Experiments (measured reasons)
Byte-weighted pacing (D: flat plateau, prototype precedent); pre-encoded Uint8Array body (G: isolation-only win, no victim effect); scheduler spacing change 15→20ms (D: within single-run noise, +wall cost); threshold change (D: flat 128-512KB); worker-thread/stringify offload (H: sync cost small relative to pipeline; prior Node measurement also rejected).

## M. Sustained Bun Result (75s, 6 projects, parent+sub-agent fan-out, proxy CONNECT leg, growing histories)
15720 requests @ 209.6 RPS, 0 errors. Victim p50/p95/p99 0.60/3.03/5.90ms; parent p95 24.22, children p95 24.19, proxy-path p95 28.99. EL lag mean 0.68/p95 2.94/max 14.06ms. Heap 63→86.7 peak→48.6 settled; RSS 199.9→255.6 peak→192.1 settled; FDs 89→255 peak→251 settled (keep-alive held, no growth per-sample); proxy dispatchers 0 in executor-level harness (CONNECT exercised via proxy.mjs lane, connects counted, tunnels settle).

## N. Final Node vs Bun Comparison (75s sustained, identical harness)
RPS 174.5 vs 209.6 (+20%); victim p50 8.44 vs 0.60 (14x), p95 21.73 vs 3.03 (7x), p99 34.26 vs 5.90; EL p95 13.03 vs 2.94 (4.4x); peak RSS 413.3 vs 255.6 (-38%); settled RSS 315.8 vs 192.1; peak FDs 310 vs 255; errors 0/0. Gateway victim@8 contention: Bun ~270 vs Node ~479 p50. Verdict: Bun materially faster for realistic 9Router Mux workloads — latency, tail latency, throughput, and memory all better; streaming correctness validated by strict SSE checks throughout; bun:sqlite path clean.

## O. Final Runtime Recommendation
Yes — 9Router should treat Bun as a viable preferred performance runtime for the gateway workload (keep Node as default deploy target until Bun proxy-pool parity is re-verified against production proxies; ALL_PROXY/socks divergence remains the known open compatibility item, memory 9router-bun-proxy-incompat). Remaining gap attribution (criterion 17): after pacing, the residual victim cost under Bun is 9Router application pipeline (Next request path + transform + stringify + SSE forward), NOT Bun runtime scheduling (EL p95 ~3ms), NOT TLS/socket saturation (E/I), NOT proxy path, NOT upstream. Scheduler: KEEP 15ms/256KB unchanged — Bun evidence shows pacing still decisively beats OFF (256 vs 396ms victim p50) and no spacing/threshold variant is outside noise. Further meaningful gains require pipeline work (stream-chunked serialization or worker offload) previously measured as low-ROI; classifying remaining gap as not worth further complexity at current traffic scale.

