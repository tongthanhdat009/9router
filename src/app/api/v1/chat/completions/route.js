import { handleChat } from "@/sse/handlers/chat.js";
import { guardPublicLlmApi } from "@/dashboardGuard";

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

export async function POST(request) {  
  const deniedLlm = await guardPublicLlmApi(request);
  if (deniedLlm) return deniedLlm;
  // Fallback to local handling
  
  return await handleChat(request);
}

