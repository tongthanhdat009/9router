// Muse (Meta) — OAuth device-code login, apiKey minted via /muse-code/key.
// Inference rides the shared openai-responses pipeline (MuseExecutor).
export default {
  id: "muse",
  priority: 40,
  alias: "muse",
  display: {
    name: "Muse",
    icon: "smart_toy",
    color: "#0668E1",
    textIcon: "MU",
    website: "https://www.meta.ai",
    notice: {
      signupUrl: "https://www.meta.ai",
    },
  },
  category: "oauth",
  authType: "oauth",
  hasOAuth: true,
  authModes: ["oauth", "apikey"],
  transport: {
    baseUrl: "https://api.meta.ai/v1",
    format: "openai-responses",
    forceStream: true,
  },
  oauth: {
    clientId: "1031625952748946",
    deviceCodeUrl: "https://auth.meta.com/oidc/device/authorization/",
    tokenUrl: "https://auth.meta.com/oidc/device/token/",
  },
  models: [
    { id: "muse-latest", name: "Muse Latest" },
  ],
  passthroughModels: true,
};
