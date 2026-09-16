import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { makeKv } from "../helpers/kvStore.js";
import { makeTtlCache } from "../cache.js";

const aliasKv = makeKv("modelAliases");
const customKv = makeKv("customModels");
const mitmKv = makeKv("mitmAlias");
const aliasCache = makeTtlCache({ ttlMs: 10000, loader: () => aliasKv.getAll() });

// modelAliases: key=alias, value=modelString
export function invalidateModelAliasesCache() { aliasCache.invalidateAll(); }

export async function getModelAliases() {
  return await aliasCache.get();
}

export async function setModelAlias(alias, model) {
  await aliasKv.set(alias, model);
  invalidateModelAliasesCache();
}

export async function deleteModelAlias(alias) {
  await aliasKv.remove(alias);
  invalidateModelAliasesCache();
}

// customModels: key=`${providerAlias}|${id}|${type}`, value=full model object
function customKey(providerAlias, id, type) {
  return `${providerAlias}|${id}|${type}`;
}

export async function getCustomModels() {
  const all = await customKv.getAll();
  return Object.values(all);
}

const ALLOWED_CUSTOM_TYPES = new Set(["llm", "imageToText"]);

// Atomic upsert inside transaction to prevent duplicate races. Re-adding an
// existing model merges name/caps over the stored JSON — omitted caps keys are
// preserved so a partial update never silently discards stored capabilities.
export async function addCustomModel({ providerAlias, id, type = "llm", name, caps, formats }) {
  if (!ALLOWED_CUSTOM_TYPES.has(type)) {
    throw new Error(`Invalid custom model type: ${type}. Allowed: llm, imageToText`);
  }
  const k = customKey(providerAlias, id, type);
  const db = await getAdapter();
  let added = false;
  db.transaction(() => {
    const row = db.get(`SELECT value FROM kv WHERE scope = 'customModels' AND key = ?`, [k]);
    if (row) {
      const prev = parseJson(row.value) || {};
      const next = {
        ...prev,
        ...(name ? { name } : {}),
        ...(caps ? { caps: { ...prev.caps, ...caps } } : {}),
        ...(Array.isArray(formats) && formats.length ? { formats } : {}),
      };
      db.run(`UPDATE kv SET value = ? WHERE scope = 'customModels' AND key = ?`, [stringifyJson(next), k]);
      return;
    }
    const value = stringifyJson({ providerAlias, id, type, name: name || id, ...(caps ? { caps } : {}), ...(Array.isArray(formats) && formats.length ? { formats } : {}) });
    db.run(`INSERT INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [k, value]);
    added = true;
  });
  return added;
}

export async function deleteCustomModel({ providerAlias, id, type }) {
  if (type) {
    await customKv.remove(customKey(providerAlias, id, type));
    // Also remove the alternate type for the same id (robust against caller passing the wrong type).
    const other = type === "llm" ? "imageToText" : "llm";
    await customKv.remove(customKey(providerAlias, id, other));
    return;
  }
  // No type provided (delete from UI where type is unknown) — try both keys.
  for (const t of ["llm", "imageToText"]) {
    await customKv.remove(customKey(providerAlias, id, t));
  }
}

export function isCustomVisionModel(m) {
  if (!m) return false;
  if (m.type === "imageToText") return true;
  if (m.capabilities && m.capabilities.vision === true) return true;
  return false;
}

// mitmAlias: key=toolName, value=mappings object
export async function getMitmAlias(toolName) {
  if (toolName) {
    const v = await mitmKv.get(toolName);
    return v || {};
  }
  return await mitmKv.getAll();
}

export async function setMitmAliasAll(toolName, mappings) {
  await mitmKv.set(toolName, mappings || {});
}
