/** Semantic-first-token latency scale in milliseconds. */
export const latencyScaleMs = 2000;
/** Largest learned weight relative to the smallest selectable weight. */
export const weightRatioCap = 8;
/** Minimum wait before another recovery probe, in milliseconds. */
export const cooldownMs = 60000;
/** Maximum simultaneous recovery probes for one layer/provider/model. */
export const maxConcurrentProbesPerKey = 1;
/** Idle metric expiry, in milliseconds. */
export const staleTtlMs = 600000;
/** Combined account and route LRU capacity. */
export const maxKeys = 2000;
/** EWMA update fraction; 0.3 dampens one-off bursts while adapting within a few samples. */
export const ewmaAlpha = 0.3;
/** Consecutive slow measurements needed to cool a candidate. */
export const slowStreakThreshold = 2;
/** Recovery needs 18 TPS (six above the 12 TPS slow boundary). */
export const recoveryTpsMargin = 18;
/** Slow boundary, TPS; mirrors affinity guard without reading its env. */
export const slowTps = 12;
/** Ignore completion samples smaller than this many tokens. */
export const minSampleTokens = 64;
/** Floor throughput duration at one second to resist burst inflation. */
export const minSpanMs = 1000;
/** Neutral cold score, roughly 18 TPS with 1s TTFT; no history is not zero speed. */
export const neutralColdPrior = 12;
/** Number of observations equivalent to the neutral prior when blending confidence. */
export const priorSamples = 2;
/** Multiplicative penalty per outstanding reservation. */
export const inflightPenalty = 1;
/** Initial recovered weight fraction; subsequent observations ramp normally. */
export const recoveryRamp = 0.5;
