import { handleDecisions } from "@/sse/handlers/decisions.js";
import { guardPublicLlmApi } from "@/dashboardGuard";

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

/** POST /v1/decisions - TypeSafe SystemOne decisions (noul/choice/score), via OpenRouter */
export async function POST(request) {
  const deniedLlm = await guardPublicLlmApi(request);
  if (deniedLlm) return deniedLlm;
  return await handleDecisions(request);
}
