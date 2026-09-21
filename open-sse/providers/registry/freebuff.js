export default {
  id: "freebuff",
  alias: "freebuff",
  display: {
    name: "FreeBuff",
    icon: "smart_toy",
    color: "#111827",
    textIcon: "FB",
    website: "https://freebuff.com",
    notice: {
      text: "Free mode (daily Freebucks) with session admission, or paid credits. Free uses official per-model agent sessions; unsupported models use paid credits.",
      apiKeyUrl: "https://freebuff.com",
    },
  },
  category: "apikey",
  hasOAuth: true,
  authModes: ["oauth", "apikey"],
  transport: {
    baseUrl: "https://www.codebuff.com/api/v1/chat/completions",
  },
  models: [
    { id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash", freeRoot: "base3-free-glm-5-3-flash" },
    // ponytail: freeRoot mirrors the executor per-model roots; if the free-model set ever diverges, derive both from one shared map.
    { id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", freeRoot: "base2-free-deepseek-v4-1-flash" },
    { id: "openai/gpt-5.6-luna", name: "GPT 5.6 Luna", freeRoot: "base3-free-luna" },
    { id: "mimo/mimo-v2.5", name: "MiMo V2.5", freeRoot: "base3-free-mimo" },
    { id: "upstage/solar-pro4", name: "Solar Pro 4", freeRoot: "base3-free-solar-pro4" },
    { id: "google/gemini-3.8-flash", name: "Gemini 3.8 Flash", freeRoot: "base3-free-gemini-3-8-flash" },
  ],
};
