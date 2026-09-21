export default {
  id: "opencode",
  priority: 40,
  hasFree: true,
  alias: "oc",
  uiAlias: "oc",
  display: {
    name: "OpenCode Free",
    icon: "terminal",
    color: "#E87040",
    textIcon: "OC",
  },
  category: "free",
  noAuth: true,
  transport: {
    baseUrl: "https://opencode.ai",
    headers: {
      "x-opencode-client": "desktop",
    },
    forceStream: true,
    noAuth: true,
    quirks: {
      forceAutoToolChoiceModels: ["muse-spark-1.3-contributor-free"],
    },
  },
  serviceKinds: ["llm", "decisions"],
  models: [
    // Endpoint formats differ per model, so declare non-chat models explicitly.
    { id: "muse-spark-1.2-contributor-free", name: "Muse Spark 1.2 Contributor Free", targetFormat: "openai-responses" },
    { id: "muse-spark-1.3-contributor-free", name: "Muse Spark 1.3 Contributor Free", targetFormat: "openai-responses" },
    { id: "union-alpha", name: "Union Alpha Free", targetFormat: "claude" },
    // Decisions models (TypeSafe Jev): NOT chat — served via POST /v1/decisions (zen SystemOne).
    // Docs: https://opencode.ai/docs/zen (Jev section, endpoint https://opencode.ai/zen/v1/systemone)
    { id: "jev-1.13", name: "TypeSafe Jev 1.13 (Decisions)", kind: "decisions" },
    { id: "jev-1.13-free", name: "TypeSafe Jev 1.13 Free (Decisions)", kind: "decisions" },
  ],
  // TypeSafe SystemOne decisions endpoint (noul/choice/score answers, not chat completions).
  // Verified live: POST https://opencode.ai/zen/v1/systemone with x-opencode-client: desktop → 200.
  decisionsConfig: {
    baseUrl: "https://opencode.ai/zen/v1/systemone",
    headers: { "x-opencode-client": "desktop" },
  },
  modelsFetcher: { url: "https://opencode.ai/zen/v1/models", type: "opencode-free" },
  passthroughModels: true,
};
