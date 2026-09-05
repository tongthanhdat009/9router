# Full-gateway benchmark acceptance ledger

Status: INCOMPLETE. No policy recommendation. Production scheduler untouched.

This is a partial smoke harness, not the requested full benchmark matrix.

Run validator: node scripts/bench/gateway/self-check.mjs
Run smoke: BENCH_OUTPUT=/tmp/gateway-benchmark.json node scripts/bench/gateway/run.mjs
Requires an env-free source checkout with dependencies. The runner refuses known Next production env files rather than reading host secrets. This checkout fails that preflight; no build or gateway launch occurred. Do not remove a user's env files to bypass it. An isolated source-copy/build step remains required.

Implemented but not runtime-verified: dedicated Next build, custom-server launch on ephemeral loopback port, temporary HOME/DATA_DIR, DB API seeding with requireApiKey=true, Bun.version/Bun.revision/executable capture, fixed Node HTTP client/upstream, bounded client samples, content/finish/DONE checks. Standalone proxy helper exists but is not integrated or verified. Existing parent-owned scheduler environment experiments remain uncommitted and are not prerequisites of this partial smoke runner.

Verified: all new .mjs files pass node --check; validator self-check passes; real runner exits 1 with isolation preflight error and writes bounded incomplete JSON, zero sample rows. No owned server processes were started. No live database, protected gateway, deployment, installation or push touched.

Missing: actual authenticated full-gateway success; real sanitized ordered diverse Mux fixtures; independent expected-vs-actual sentinel; request-internal stage instrumentation; payload identity and upstream byte reconciliation; strict CONNECT/abort verification; default/OFF/5/10/15/20/byte policy comparisons without double pacing; threshold 128/256/512 KiB selection; heavy 0/1/2/4/8; fanout16; heavy/victim HTTP/HTTPS four-way; encoding-inclusive alternating A/B; exact-byte serialization and yield A/B; upload1/2/4/8/16; backlog8/16/25/50; ordered 2MB/300KB/2MB/700KB/1.3MB; 60-second Bun ON/OFF and Node reference; resource sampling and sufficient idle settle; native Bun CPU profile.

Invalid inherited evidence: direct-executor victim-stages is not full HTTP ingress; prototype wrapper double pacing invalidates policy baseline; cold string then warm Uint8Array excludes encoding/order costs; measured-runtime upstream/proxy conflates server changes; three-second FD plateau is not leak proof. No exploratory timing values copied into acceptance JSON. Identifier absence in minified Next bundles does not prove staleness.

Tail rule: fewer than 100 samples reports p95=null and undersampled, not policy optimality. Even >=100 samples does not itself establish statistical confidence.
