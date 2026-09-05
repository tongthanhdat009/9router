# Controlled full-gateway matrix

Candidate override: prefix measurement commands with CANDIDATE_SPACING_MS=20 CANDIDATE_THRESHOLD_BYTES=262144 (TRAFFIC_PACING_SPACING_MS / TRAFFIC_PACING_THRESHOLD also accepted). Validated numbers inherited by all cells; explicit OFF, spacing-sweep values, and threshold-sweep values take precedence. No production defaults changed.

Updated mixed workload: exactly five launches ordered 2MiB -> 300KiB -> 2MiB -> 700KiB -> 1.3MiB, integer rounded UTF-8 body sizes. Threshold matrix additionally includes 64KiB/768KiB/1MiB/1.7MiB at each 128/256/512KiB threshold.

Sustained workload: 7 mixed-role workers alternating parent-history heavy and child small requests across direct/proxy origins (role/project/checkpoint/proxy labels), plus a dedicated independent victim worker on the victim origin every 50ms (role=victim). CONNECT snapshots captured before warm, at window start, window end, and settle; positive evidence requires successful tunnel bytes in warm-or-window and zero failures; settled active-tunnel count is an observation only (resource retention under investigation, never forced zero). Threshold grid is one deduplicated size set [64,128,192,256,384,512,768,1024,1741]KiB plus each threshold boundary -1/at/+1 crossed identically with OFF and 128/256/512 policies; heavyBatchWallMs = max completed-heavy endOffsetMs, separate from the 100-probe windowWallMs.

Sustained histories: BENCH_HISTORY_IDS=e8cf0d0b8f,4bb8445a74,4788ba8b9a selects real sanitized parent histories; missing files fail, never padded fallback. Each uses approximately first 1.2MB at complete tool-result boundaries; 25/50/75/100% prefixes advance every 18.75s. Samples retain project label/checkpoint; output records checkpoint byte/hash identities, never message contents. Gateway telemetry samples its own /proc PID FDs at window start and every second, retaining bounded fdSamples offsetMs/total plus fdPeak; no ss subprocess in measured client path. Assertions require nonempty lag, no FD errors, and exact expected threshold-eligible admission byte multiset (empty for OFF/subthreshold).

Implementation checked; load benchmarks NOT run. No runtime/default recommendation.

Correctness only:
```sh
node scripts/bench/gateway/matrix-check.mjs
node scripts/bench/gateway/telemetry-check.mjs
node scripts/bench/gateway/self-check.mjs
for f in scripts/bench/gateway/*.mjs; do node --check "$f" || exit; done
```

Measurement commands (run only when authorized):
```sh
for mode in spacing protection tls prepare encoding upload backlog threshold mixed sustained; do
  BENCH_ROOT=/tmp/9r-controlled-build MODE=$mode RUNS=5 SEED=42 RUNTIMES=bun,node BENCH_OUTPUT=/tmp/gateway-$mode.json node scripts/bench/gateway/matrix.mjs || break
done
```

One isolated Next build reused across modes/runtime pairs. Source/dependency/runtime hashes plus dirty tracked-patch and dirty-file hashes recorded. No installs. Source env files excluded; fresh DATA_DIR each driver. Independent fixed-Node heavy/victim HTTP/HTTPS helpers; fixed-Node client. HTTPS default except explicit four-way TLS cells. Controlled copy strips synchronous legacy instrumentation, injects bounded in-memory admissions, and retains encoding cost inside BaseExecutor dispatch. Original dirty scheduler/base files remain untouched/uncommitted.

Spacing: five balanced seeded OFF/10/15/20 blocks, one eight-heavy burst per row, exactly 100 probes scheduled at 5ms offsets; all samples/errors/dispatch+completion exposure retained. Protection is separately labelled 100 repeated bursts, not a substitute for single-burst results. Warm heavy concurrency and victim path before reset/window start. CPU uses process.cpuUsage(start), memory/lag reset per window; timer lag resets expected deadline each tick.

Prepare ON/OFF c1/4/8/16; encoding string/buffer c1/4/8; upload OFF/fixed c1/2/4/8/16; backlog OFF/fixed c8/16/25/50; threshold 128/256/512KiB at exact serialized UTF-8 threshold +/-1 byte; mixed fixed/OFF/byte-weighted five-request ordered sizes. Every non-sustained cell carries exactly 100 independent victim probes; prepare/encoding/upload/backlog/threshold/mixed rows assert the expected probe count. Sustained: 75s eight-worker direct+CONNECT mixed-size workload, samples preserved, gateway PID FD/socket classification at load end and 3/10/30/60s thereafter, proxy attempt/success/failure/active/peak counters.

Every response validates SSE terminal, finish, and exact 512-character payload; all upstream requests reconcile count, bytes, canonical JSON hash multiset (model prefix rewrite allowed). Any errors, evidence overflow, dropped samples, or failed reconciliation leave status incomplete and nonzero exit. Canonical hashes test payload semantics rather than incidental JSON key ordering.

Limits: real fixture requires local ~/.mux/sessions/e8cf0d0b8f/chat.jsonl; strict payload contract deliberately fails if gateway adds/removes fields. No production integration/build smoke performed in this task; correctness checks cannot prove the copied Next bundle/preload integration until authorized execution. Linux /proc and ss required for resource attribution; TIME_WAIT lacks owning PID and is not attributed.
