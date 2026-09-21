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
      text: "Sign in once with the FreeBuff CLI, then paste its auth token here. Free-mode admission is not supported.",
      apiKeyUrl: "https://freebuff.com",
    },
  },
  category: "apikey",
  transport: {
    baseUrl: "https://www.codebuff.com/api/v1/chat/completions",
  },
  models: [
    { id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash" },
    { id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
    { id: "openai/gpt-5.6-luna", name: "GPT 5.6 Luna" },
    { id: "mimo/mimo-v2.5", name: "MiMo V2.5" },
    { id: "upstage/solar-pro4", name: "Solar Pro 4" },
    { id: "google/gemini-3.8-flash", name: "Gemini 3.8 Flash" },
  ],
};
