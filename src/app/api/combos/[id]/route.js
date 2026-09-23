import { NextResponse } from "next/server";
import { getComboById, updateCombo, deleteCombo, getComboByName, updateSettings, getSettings } from "@/lib/localDb";
import { resetComboRotation } from "open-sse/services/combo.js";

// Validate combo name: only a-z, A-Z, 0-9, -, _
const VALID_NAME_REGEX = /^[a-zA-Z0-9_.\-]+$/;

// GET /api/combos/[id] - Get combo by ID
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const combo = await getComboById(id);
    
    if (!combo) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }
    
    return NextResponse.json(combo);
  } catch (error) {
    console.log("Error fetching combo:", error);
    return NextResponse.json({ error: "Failed to fetch combo" }, { status: 500 });
  }
}

// PUT /api/combos/[id] - Update combo
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    
    // Validate name format if provided
    if (body.name) {
      if (!VALID_NAME_REGEX.test(body.name)) {
        return NextResponse.json({ error: "Name can only contain letters, numbers, -, _ and ." }, { status: 400 });
      }
      
      // Check if name already exists (exclude current combo)
      const existing = await getComboByName(body.name);
      if (existing && existing.id !== id) {
        return NextResponse.json({ error: "Combo name already exists" }, { status: 400 });
      }
    }
    
    // Capture previous name to invalidate rotation state on rename
    const prev = await getComboById(id);
    const combo = await updateCombo(id, body);
    
    if (!combo) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }

    // Invalidate rotation state (models/strategy/name may have changed)
    if (prev?.name) resetComboRotation(prev.name);
    if (combo.name && combo.name !== prev?.name) {
      resetComboRotation(combo.name);
      // Move the strategy entry so old route state never leaks into a same-name new combo.
      const settings = await getSettings();
      const strategies = settings.comboStrategies || {};
      if (strategies[prev.name] !== undefined && strategies[combo.name] === undefined) {
        await updateSettings({ comboStrategies: { [combo.name]: strategies[prev.name], [prev.name]: null } });
      } else if (strategies[prev.name] !== undefined) {
        await updateSettings({ comboStrategies: { [prev.name]: null } });
      }
      try {
        const { adaptiveRouter } = await import("open-sse/services/adaptiveRouter.js");
        adaptiveRouter.invalidate({});
      } catch { /* ponytail: engine absent in dashboard-only builds */ }
    }

    return NextResponse.json(combo);
  } catch (error) {
    console.log("Error updating combo:", error);
    return NextResponse.json({ error: "Failed to update combo" }, { status: 500 });
  }
}

// DELETE /api/combos/[id] - Delete combo
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const prev = await getComboById(id);
    const success = await deleteCombo(id);
    
    if (!success) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }

    if (prev?.name) {
      resetComboRotation(prev.name);
      await updateSettings({ comboStrategies: { [prev.name]: null } });
      try {
        const { adaptiveRouter } = await import("open-sse/services/adaptiveRouter.js");
        adaptiveRouter.invalidate({});
      } catch { /* ponytail: engine absent in dashboard-only builds */ }
    }
    
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting combo:", error);
    return NextResponse.json({ error: "Failed to delete combo" }, { status: 500 });
  }
}
