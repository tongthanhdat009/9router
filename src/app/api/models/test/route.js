import { NextResponse } from "next/server";
import { getRegistryKind } from "open-sse/config/providerModels.js";
import { pingModelByKind } from "./ping";

// Resolve a model id to its registry kind (e.g. openrouter/typesafe/jev-1.13 → decisions)
// so UI callers that omit `kind` still ping the right endpoint. Unknown → caller kind || llm.
function resolveRegistryKind(model, fallbackKind) {
  try {
    const [prefix, ...rest] = String(model).split("/");
    if (!rest.length) return fallbackKind || "llm";
    return getRegistryKind(prefix, rest.join("/")) || fallbackKind || "llm";
  } catch {
    return fallbackKind || "llm";
  }
}

// POST /api/models/test - Ping a single model via the internal endpoint matching its kind
// (chat completions, embeddings, decisions, ...). `kind` is optional: when omitted it
// is resolved from the provider registry so decisions models never hit /v1/chat/completions.
export async function POST(request) {
  try {
    const { model, kind } = await request.json();
    if (!model) return NextResponse.json({ error: "Model required" }, { status: 400 });
    const result = await pingModelByKind(model, resolveRegistryKind(model, kind));
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
