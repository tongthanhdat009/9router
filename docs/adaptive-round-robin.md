<!-- gitignored by repo convention (docs/*); this deliverable stays workspace-visible for review. -->
# Adaptive round robin

Opt-in speed-aware weighted rotation at two layers: combo route selection
(`comboStrategies[name].fallbackStrategy = "adaptive-round-robin"`) and per-provider
account selection (`providerStrategies[id].fallbackStrategy = "adaptive-round-robin"`).
Legacy `fallback`, `round-robin`, `fill-first`, and `fusion` behavior is unchanged
when adaptive is off.

## Formula

Score = `tps / (1 + semanticTtftMs / latencyScaleMs)`, blended with a neutral cold
prior (`neutralColdPrior`, `priorSamples`) and reduced by in-flight reservations
(`inflightPenalty`). The largest learned weight is capped at `weightRatioCap`
times the smallest selectable weight. Winner advances its smooth weighted
round-robin credit by the total weight; one advance per logical request.

## Defaults (`open-sse/config/adaptive.js`)

`latencyScaleMs=2000`, `weightRatioCap=8`, `cooldownMs=60000`,
`maxConcurrentProbesPerKey=1`, `staleTtlMs=600000`, `maxKeys=2000`,
`ewmaAlpha=0.3`, `slowStreakThreshold=2`, `recoveryTpsMargin=18`, `slowTps=12`,
`minSampleTokens=64`, `minSpanMs=1000`, `neutralColdPrior=12`, `priorSamples=2`,
`inflightPenalty=1`, `recoveryRamp=0.5`. Tune constants only; no code changes.

## Aggregation

Account observations aggregate route health for the same
`(providerId, modelId)` pair. Route selection never reserves a separate ticket:
one logical request = one scheduler advance at the route layer plus at most one
account reservation. All-cooled candidates fall back to input order; a single
synchronized probe is admitted per key. Alias-canonicalized by callers.

## Lifecycle

- Streaming completions emit exactly one terminal observation per attempt
  (canonical usage + semantic timing). Duplicate terminal frames and
  late callbacks after generation reset are rejected.
- Non-streaming JSON is latency-only: the lease releases without a TPS sample.
- Client cancel/abort is an explicit ignore (`cancelled`), never failure;
  reauth/upstream failures release the lease without sampling.
- `200`-without-usage is ignored (`insufficient_tokens`); estimated usage
  (`usage.estimated`) is never sampled.
- Responses `usage.output_tokens` maps to completion tokens (observed in
  `open-sse/transformer/streamToJsonConverter.js`); reasoning + tool-argument
  tokens count via the canonical accumulation without double-counting.
- Account selection runs after the eligibility filter (quota/auth/model-lock
  exclusions never probed). `x-connection-id` is a required pin that adaptive
  never overrides; opportunistic account affinity may be overridden.
- Refresh preserves learning (same connection id); delete/recreate resets via
  `invalidate`/generation bump. D6.

## Diagnostics

Request detail reports `selection.comboStrategy = "adaptive-round-robin"` at the
route layer and `selection.accountStrategy = "adaptive-round-robin"` with
`accountSource = "adaptive_round_robin"` at the account layer. Bounded opt-in
structured events: `adaptive.observation` (selection reason, sample
accept/ignore), adaptive override of account affinity
(`affinity.account.adaptive_overridden`), route candidates via
`adaptiveRouter.snapshot()` (score/weight, cooldown/probe, recovery state).

## Limitations

- Unsupported modalities (image/video/stt/tts/embeddings/search/fetch,
  decisions, passthrough route) resolve to legacy strategies only. D2.
- Adaptive applies to chat lifecycles with completion callbacks; sticky limits
  apply to legacy strategies only (D3); fusion remains separate (D5).
- Process-local metrics; no per-token writes; billing usage identical.

## Rollback

Set the combo `fallbackStrategy` back to `fallback`/`round-robin` and the
provider `fallbackStrategy` back to `fill-first`/`round-robin`; or clear
`comboStrategies[name]` / `providerStrategies[id]` to inherit. Deterministic
legacy behavior resumes immediately; in-memory learning expires via TTL or
`adaptiveRouter.reset()`.

## Status and verification (2026-09-24)

- Implementation commits: db922cff (adaptive service + config), fc062531 (route/account integration), 32b89a21 (this doc), 0595900e..51494ddd (settings/UI + diagnostics endpoint), 0f206de6 (estimated-usage disposition + integration tests), 2ab9ffb5 (probe recovery wiring + review fixes), fc307856 (regression baseline refresh, A/B-proven), 9640631e (onSelection payload fix).
- Test tiers: unit service 21/21 (tests/unit/adaptive-router.test.js); integration 13+ route-account + settings-ui suites green; full non-live regression gate green after baseline refresh (73 entries proven failing identically on pre-feature base df712b77; 1 real regression fixed).
- Isolated runtime proof: /tmp/adaptive-e2e-redo/ (manifest.json thresholds, summary.json results, per-request logs).
- Enable: Dashboard > Combos > set combo strategy to Adaptive Round Robin - speed aware; Dashboard > Providers > (account) Connections strategy to adaptive-round-robin. Absent override = inherit global. Both layers are independent opt-ins.
- Revert: set each layer back to Round Robin / Fill First; process-local learning resets on disable or server restart.
- Known limitations: process-local learning (no cross-worker share), cold start after restart, completed-request measurement only (a slow in-flight response is never rescued), estimated or missing usage never learned, non-stream responses contribute latency-only observations.
