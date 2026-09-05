# Full-gateway benchmark acceptance ledger

Status: INCOMPLETE. No policy recommendation. Production scheduler untouched.

This is a partial smoke harness, not the requested full benchmark matrix.

Run validator: node scripts/bench/gateway/self-check.mjs
Run smoke: BENCH_OUTPUT=/tmp/gateway-benchmark.json node scripts/bench/gateway/run.mjs
Requires an env-free source checkout with dependencies. The runner refuses known Next production env files rather than reading host secrets. This checkout fails that preflight; no build or gateway launch occurred. Do not remove a user's env files to bypass it. An isolated source-copy/build step remains required.

Implemented but not runtime-verified: dedicated Next build, custom-server launch on ephemeral loopback port, temporary HOME/DATA_DIR, DB API seeding with requireApiKey=true, Bun.version/Bun.revision/executable capture, fixed Node HTTP client/upstream, bounded client samples, content/finish/DONE checks. Standalone proxy helper exists but is not integrated or verified. Existing parent-owned scheduler environment experiments remain uncommitted and are not prerequisites of this partial smoke runner.

Verified this session: strict terminal-last validator + trailing-data negative restored (HEAD parity; Node+Bun self-check green); all 4 gateway .mjs files pass node --check; isolated full HTTP smoke ran once (Bun 1.4.1 gateway, dedicated .next build I4vVI9xZQbOQtNtLVWh4R, temp HOME/DATA_DIR, loopback, sentinel leg passed).

RED: heavy leg failed strict validation — gateway emitted DOUBLE `data: [DONE]` in passthrough mode (artifact /tmp/9r-gateway-artifact-SsLuJW/sse-validation-failure.txt; ordering dataLines=3: [finish-chunk stop, DONE, DONE], donePosition=1). Source cause: open-sse/utils/stream.js passthrough forwards upstream [DONE] (:141 excludes it from JSON handling, :231-240 re-emits verbatim without setting streamDoneSent) then flush synthesizes a second (:409-413, `!streamDoneSent` still true). Previous Bun smoke passed only because the validator was weakened to DONE-anywhere. Production stream.js untouched this session (constraint); fix belongs there: set streamDoneSent when forwarding upstream [DONE], or suppress flush synthesis when the tail already ends in DONE. Validation stays RED until one isolated smoke passes the strict check.

Byte reconciliation (unmeasured, instrumented for next run): chatCore.js:103+202 rewrite verified at source — routed model bench/benchmark-model serialized upstream as benchmark-model (6-byte `bench/` diff matches prior 1716388 vs 1716382 delta); run.mjs now recomputes expected upstream body + expectedUpstreamBytes + modelRewriteBytes and compares sorted-key canonical sha256 (upstream.mjs captures stats.last.{bytes,sha256,canonicalSha256,model}); raw-byte sha recorded but NOT asserted (gateway re-serialization may reorder keys). No raw fixture contents committed; no owned servers left running. No live database, protected gateway, deployment, installation or push touched.

Missing: actual authenticated full-gateway success; real sanitized ordered diverse Mux fixtures; independent expected-vs-actual sentinel; request-internal stage instrumentation; payload identity and upstream byte reconciliation; strict CONNECT/abort verification; default/OFF/5/10/15/20/byte policy comparisons without double pacing; threshold 128/256/512 KiB selection; heavy 0/1/2/4/8; fanout16; heavy/victim HTTP/HTTPS four-way; encoding-inclusive alternating A/B; exact-byte serialization and yield A/B; upload1/2/4/8/16; backlog8/16/25/50; ordered 2MB/300KB/2MB/700KB/1.3MB; 60-second Bun ON/OFF and Node reference; resource sampling and sufficient idle settle; native Bun CPU profile.

Invalid inherited evidence: direct-executor victim-stages is not full HTTP ingress; prototype wrapper double pacing invalidates policy baseline; cold string then warm Uint8Array excludes encoding/order costs; measured-runtime upstream/proxy conflates server changes; three-second FD plateau is not leak proof. No exploratory timing values copied into acceptance JSON. Identifier absence in minified Next bundles does not prove staleness.

Tail rule: fewer than 100 samples reports p95=null and undersampled, not policy optimality. Even >=100 samples does not itself establish statistical confidence.
