import { proxy as dashboardProxy } from "./dashboardGuard";

export default async function proxy(request) {
  return dashboardProxy(request);
}

export const config = {
  // Chat completions is excluded: its route calls guardPublicLlmApi itself.
  // Avoiding middleware here saves ~0.5-0.8ms CPU per inference request.
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|(?:api/v1/chat/completions|v1/chat/completions)(?:/|$)).*)"],
};
