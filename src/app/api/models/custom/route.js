import { NextResponse } from "next/server";
import { getCustomModels, addCustomModel, deleteCustomModel } from "@/models";
import { CAPACITY_META } from "@/shared/constants/models";
import { PROVIDERS } from "open-sse/providers/index.js";
import REGISTRY from "open-sse/providers/registry/index.js";

export const dynamic = "force-dynamic";

const KNOWN_WIRE_FORMATS = new Set(["openai", "openai-responses", "claude", "gemini", "gemini-cli", "vertex"]);

// Whitelist upstream wire formats; unknown strings are dropped. Empty → null
// (no pin, catalog/registry resolution applies as before).
export function sanitizeFormats(formats) {
  if (!Array.isArray(formats)) return null;
  const clean = [...new Set(formats.filter((f) => KNOWN_WIRE_FORMATS.has(f)))];
  return clean.length ? clean : null;
}

// Whitelist capability flags to booleans; anything else (junk/empty) means
// "no stored caps" so tri-state unknown stays unknown instead of becoming false.
export function sanitizeCaps(caps) {
  if (!caps || typeof caps !== "object" || Array.isArray(caps)) return null;
  const clean = {};
  for (const key of Object.keys(CAPACITY_META)) {
    if (typeof caps[key] === "boolean") clean[key] = caps[key];
  }
  return Object.keys(clean).length ? clean : null;
}

// GET /api/models/custom - List all custom models
export async function GET() {
  try {
    const models = await getCustomModels();
    // Per-provider selectable wire formats: multi-transport providers expose their
    // declared transports; single-transport providers resolve to one entry (UI hides
    // the picker — requests always translate to that provider's only format).
    const formatsByProvider = {};
    const aliasKeysOf = new Map(REGISTRY.map((r) => [r.id, [r.alias, r.uiAlias, ...(r.aliases || [])].filter(Boolean)]));
    for (const [id, cfg] of Object.entries(PROVIDERS)) {
      const formats = Array.isArray(cfg?.transports)
        ? [...new Set(cfg.transports.map((t) => t.format))]
        : [cfg?.format].filter(Boolean);
      if (!formats.length) continue;
      // Key by provider id plus every alias the UI may address it with (ocg, ag, ...).
      for (const key of [id, ...(aliasKeysOf.get(id) || [])]) formatsByProvider[key] = formats;
    }
    return NextResponse.json({ models, formatsByProvider });
  } catch (error) {
    console.log("Error fetching custom models:", error);
    return NextResponse.json({ error: "Failed to fetch custom models" }, { status: 500 });
  }
}

// POST /api/models/custom - Add custom model
const ALLOWED_CUSTOM_TYPES = new Set(["llm", "imageToText"]);

export async function POST(request) {
  try {
    const { providerAlias, id, type, name, caps, formats } = await request.json();
    if (!providerAlias || !id) {
      return NextResponse.json({ error: "providerAlias and id required" }, { status: 400 });
    }
    const resolvedType = type || "llm";
    if (!ALLOWED_CUSTOM_TYPES.has(resolvedType)) {
      return NextResponse.json({ error: `Invalid type: ${resolvedType}. Allowed: llm, imageToText` }, { status: 400 });
    }
    const cleanCaps = sanitizeCaps(caps);
    const cleanFormats = sanitizeFormats(formats);
    const added = await addCustomModel({ providerAlias, id, type: resolvedType, name, ...(cleanCaps ? { caps: cleanCaps } : {}), ...(cleanFormats ? { formats: cleanFormats } : {}) });
    return NextResponse.json({ success: true, added });
  } catch (error) {
    console.log("Error adding custom model:", error);
    return NextResponse.json({ error: "Failed to add custom model" }, { status: 500 });
  }
}

// DELETE /api/models/custom?providerAlias=xxx&id=yyy&type=zzz
// type is optional — when omitted both llm and imageToText keys are tried.
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const providerAlias = searchParams.get("providerAlias");
    const id = searchParams.get("id");
    const type = searchParams.get("type") || undefined;
    if (!providerAlias || !id) {
      return NextResponse.json({ error: "providerAlias and id required" }, { status: 400 });
    }
    await deleteCustomModel({ providerAlias, id, type });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting custom model:", error);
    return NextResponse.json({ error: "Failed to delete custom model" }, { status: 500 });
  }
}
