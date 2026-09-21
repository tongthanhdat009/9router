import { CLAUDE_API_HEADERS } from "../shared.js";

// ZCode (Z.ai Coding Plan) — device-flow OAuth, zcode.z.ai platform-gateway
// anthropic inference, off-peak ticketed channel. Builtin ids mirror zcode-builtin.json.
// Scalars inlined (no src/lib import): registry entries must not import src/
// (bare open-sse specifier inside src constants breaks root node resolution).
export default {
  id: "zcode",
  priority: 45,
  alias: "zcode",
  display: {
    name: "ZCode",
    icon: "terminal",
    color: "#7C3AED",
    textIcon: "ZC",
    website: "https://zcode.z.ai",
    notice: { signupUrl: "https://z.ai" },
  },
  category: "oauth",
  authType: "oauth",
  hasOAuth: true,
  authModes: ["oauth"],
  transport: {
    // official ZCode client rewrites api.z.ai/... to this gateway (official-coding-plan-gateway.ts:22-31).
    baseUrl: "https://zcode.z.ai/api/v1/ultra-zai/anthropic/v1/messages",
    format: "claude",
    headers: { "anthropic-version": "2023-06-01", ...CLAUDE_API_HEADERS },
    // official client executes web_search upstream natively (tool-transform.ts);
    // other tools run client-side so passthrough is correct.
    quirks: { claudeSupportedToolTypes: ["web_search_20250305", "web_search_20260209"] },
  },
  oauth: {
    clientId: "client_P8X5CMWmlaRO9gyO-KSqtg",
    initUrl: "https://zcode.z.ai/api/v1/oauth/cli/init",
    pollUrl: "https://zcode.z.ai/api/v1/oauth/cli/poll/",
    tokenUrl: "https://zcode.z.ai/api/v1/oauth/token",
  },
  features: { usage: false },
  models: [
    // canonical official builtin ids (zcode-builtin.json); lowercase kept as legacy.
    { id: "GLM-5.3" },
    { id: "GLM-5.3-Flash" },
    { id: "glm-5.3" },
    { id: "glm-5.3-flash" },
    { id: "glm-5.2" },
    { id: "glm-5.1" },
    { id: "glm-5" },
    { id: "glm-4.7" },
    { id: "glm-4.6v" },
  ],
};
