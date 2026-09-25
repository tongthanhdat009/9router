import { NextResponse } from "next/server";
import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession";
import { adaptiveRouter } from "open-sse/services/adaptiveRouter.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  // Require a dashboard JWT even when the normal dashboard login toggle is off.
  const token = request.cookies.get("auth_token")?.value;
  if (!token || !(await verifyDashboardAuthToken(token))) {
    // Deny-by-default: requireLogin=false must not leak route learning data.
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const snapshot = adaptiveRouter.snapshot();
  const now = Date.now();
  return NextResponse.json({
    generation: snapshot.generation,
    entries: snapshot.entries.slice(-100).map(({ key, samples, tps, ttftMs, score, inFlight, probeCount, cooledUntil }) => ({
      layer: key[0], provider: String(key[1]).slice(0, 100), model: String(key[2]).slice(0, 100),
      // Only route/model identifiers: never expose account connection IDs or credentials.
      samples, tps, semanticTtftMs: ttftMs, weight: score, inFlight, probeCount,
      cooldownMs: Math.max(0, cooledUntil - now), confidence: samples === 0 ? "learning" : samples < 3 ? "low" : "established",
    })),
  }, { headers: { "Cache-Control": "no-store" } });
}
