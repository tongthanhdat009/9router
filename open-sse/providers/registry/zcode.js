import { CLAUDE_API_HEADERS } from "../shared.js";

// ZCode (Z.ai Coding Plan) — device-flow OAuth, api.z.ai anthropic inference,
// off-peak ticketed channel on zcode.z.ai. Coding-plan models mirror glm list.
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
    baseUrl: "https://api.z.ai/api/anthropic/v1/messages",
    format: "claude",
    headers: { "anthropic-version": "2023-06-01", ...CLAUDE_API_HEADERS },
  },
  oauth: {
    clientId: "client_P8X5CMWmlaRO9gyO-KSqtg",
    initUrl: "https://zcode.z.ai/api/v1/oauth/cli/init",
    pollUrl: "https://zcode.z.ai/api/v1/oauth/cli/poll/",
    tokenUrl: "https://zcode.z.ai/api/v1/oauth/token",
  },
  features: { usage: true },
  models: [
    { id: "glm-5.3" },
    { id: "glm-5.3-flash" },
    { id: "glm-5.2" },
    { id: "glm-5.1" },
    { id: "glm-5" },
    { id: "glm-4.7" },
    { id: "glm-4.6v" },
  ],
};
