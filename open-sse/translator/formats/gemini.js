// Gemini helper functions for translator

import { safeParseJSON } from "../concerns/json.js";
import { OPENAI_BLOCK } from "../schema/index.js";

// Unsupported JSON Schema constraints that should be removed for Antigravity
export const UNSUPPORTED_SCHEMA_CONSTRAINTS = [
  // Basic constraints (not supported by Gemini API)
  "minLength", "maxLength", "exclusiveMinimum", "exclusiveMaximum",
  "minItems", "maxItems", "format", "multipleOf",
  // Array keywords the Gemini schema proto has no field for. Agent tool
  // schemas set these routinely, and one occurrence rejects the whole request
  // with "Unknown name ...: Cannot find field".
  "uniqueItems", "contains",
  // 2020-12 keywords with no Gemini equivalent
  "unevaluatedProperties", "unevaluatedItems", "contentSchema",
  // Claude rejects these in VALIDATED mode
  "default", "examples",
  // JSON Schema meta keywords
  "$schema", "$defs", "definitions", "const", "$ref", "$comment",
  // Annotation keywords (rejected by Gemini/Antigravity - e.g. MCP tool schemas set these)
  "deprecated", "readOnly", "writeOnly",
  // Object validation keywords (not supported)
  "additionalProperties", "propertyNames", "patternProperties", "enumDescriptions",
  // Complex schema keywords (handled by flattenAnyOfOneOf/mergeAllOf)
  "anyOf", "oneOf", "allOf", "not",
  // Dependency keywords (not supported)
  "dependencies", "dependentSchemas", "dependentRequired",
  // Other unsupported keywords
  "title", "optional", "deprecated", "if", "then", "else", "contentMediaType", "contentEncoding",
  // UI/Styling properties (from Cursor tools - NOT JSON Schema standard)
  "cornerRadius", "fillColor", "fontFamily", "fontSize", "fontWeight",
  "gap", "padding", "strokeColor", "strokeThickness", "textColor"
];

// Default safety settings
export const DEFAULT_SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
  { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "OFF" }
];

// Convert OpenAI content to Gemini parts
export function convertOpenAIContentToParts(content) {
  const parts = [];

  if (typeof content === "string") {
    parts.push({ text: content });
  } else if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === OPENAI_BLOCK.TEXT) {
        parts.push({ text: item.text });
      } else if (item.type === OPENAI_BLOCK.IMAGE_URL && item.image_url?.url?.startsWith("data:")) {
        const url = item.image_url.url;
        const commaIndex = url.indexOf(",");
        if (commaIndex !== -1) {
          const mimePart = url.substring(5, commaIndex); // skip "data:"
          const data = url.substring(commaIndex + 1);
          const mimeType = mimePart.split(";")[0];

          parts.push({
            inlineData: { mime_type: mimeType, data: data }
          });
        }
      } else if (item.type === OPENAI_BLOCK.IMAGE_URL && item.image_url?.url && (item.image_url.url.startsWith("http://") || item.image_url.url.startsWith("https://"))) {
        parts.push({
          fileData: { fileUri: item.image_url.url, mimeType: "image/*" }
        });
      } else if (item.type === OPENAI_BLOCK.INPUT_AUDIO && item.input_audio?.data) {
        const format = item.input_audio.format || "wav";
        const mimeType = format === "mp3" ? "audio/mpeg" : `audio/${format}`;
        parts.push({
          inlineData: { mime_type: mimeType, data: item.input_audio.data }
        });
      } else if (item.type === OPENAI_BLOCK.AUDIO_URL && item.audio_url?.url?.startsWith("data:")) {
        const url = item.audio_url.url;
        const commaIndex = url.indexOf(",");
        if (commaIndex !== -1) {
          const mimePart = url.substring(5, commaIndex);
          const data = url.substring(commaIndex + 1);
          const mimeType = mimePart.split(";")[0];
          parts.push({
            inlineData: { mime_type: mimeType, data: data }
          });
        }
      } else if (item.type === OPENAI_BLOCK.FILE && item.file?.file_data?.startsWith("data:")) {
        const url = item.file.file_data;
        const commaIndex = url.indexOf(",");
        if (commaIndex !== -1) {
          const mimeType = url.substring(5, commaIndex).split(";")[0];
          const data = url.substring(commaIndex + 1);
          parts.push({ inlineData: { mime_type: mimeType, data: data } });
        }
      }
    }
  }

  return parts;
}

// Extract text content from OpenAI content
export function extractTextContent(content, separator = "") {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter(c => c.type === OPENAI_BLOCK.TEXT).map(c => c.text).join(separator);
  }
  return "";
}

// Try parse JSON safely (null fallback on parse error; re-export keeps legacy API)
export function tryParseJSON(str) {
  return safeParseJSON(str, null);
}

// Generate request ID
export function generateRequestId() {
  return `agent-${crypto.randomUUID()}`;
}

// Generate session ID (binary-compatible format: UUID + timestamp)
export function generateSessionId() {
  return crypto.randomUUID() + Date.now().toString();
}

// Generate project ID
export function generateProjectId() {
  const adjectives = ["useful", "bright", "swift", "calm", "bold"];
  const nouns = ["fuze", "wave", "spark", "flow", "core"];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return `${adj}-${noun}-${crypto.randomUUID().slice(0, 5)}`;
}

// Merge allOf schemas at one node.
function mergeAllOf(obj) {
  if (!obj.allOf || !Array.isArray(obj.allOf)) return;
  const merged = {};
  for (const item of obj.allOf) {
    if (item.properties) {
      if (!merged.properties) merged.properties = {};
      Object.assign(merged.properties, item.properties);
    }
    if (item.required && Array.isArray(item.required)) {
      if (!merged.required) merged.required = [];
      for (const req of item.required) if (!merged.required.includes(req)) merged.required.push(req);
    }
  }
  delete obj.allOf;
  if (merged.properties) obj.properties = { ...obj.properties, ...merged.properties };
  if (merged.required) obj.required = [...(obj.required || []), ...merged.required];
}

// Select best schema from anyOf/oneOf
function selectBest(items) {
  let bestIdx = 0;
  let bestScore = -1;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let score = 0;
    const type = item.type;

    if (type === "object" || item.properties) {
      score = 3;
    } else if (type === "array" || item.items) {
      score = 2;
    } else if (type && type !== "null") {
      score = 1;
    }

    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  return bestIdx;
}

// Flatten anyOf/oneOf at one node.
function flattenAnyOfOneOf(obj) {
  for (const key of ["anyOf", "oneOf"]) {
    if (!Array.isArray(obj[key]) || obj[key].length === 0) continue;
    const schemas = obj[key].filter(s => s && s.type !== "null");
    if (schemas.length > 0) {
      const selected = schemas[selectBest(schemas)];
      delete obj[key];
      Object.assign(obj, selected);
    }
  }
}

function cleanupRequired(obj) {
  if (!Array.isArray(obj.required) || !obj.properties) return;
  const validRequired = obj.required.filter(field => Object.prototype.hasOwnProperty.call(obj.properties, field));
  if (validRequired.length === 0) delete obj.required;
  else obj.required = validRequired;
}

function addPlaceholder(obj) {
  if (Object.keys(obj).length === 0) {
    obj.type = "object";
    obj.properties = { reason: { type: "string", description: "Brief explanation of why you are calling this tool" } };
    obj.required = ["reason"];
  } else if (obj.type === "object" && obj.properties === undefined) {
    // ponytail: placeholder only when the properties map is ABSENT (orphan {} after
    // $ref strip); a present-but-empty map stays {} — Google accepts empty maps but
    // rejects placeholder keys rewritten inside them.
    obj.properties = { reason: { type: "string", description: "Brief explanation of why you are calling this tool" } };
    obj.required = ["reason"];
  }
}

// Tracks schemas already cleaned in this process so the Antigravity executor can
// skip a duplicate clone + recursive walk after request translation. WeakSet keeps
// no strong references and never leaks into serialized provider payloads.
const antigravityCleanedSchemas = new WeakSet();

export function isAntigravitySchemaClean(schema) {
  return !!schema && typeof schema === "object" && antigravityCleanedSchemas.has(schema);
}

// Clean JSON Schema for Antigravity API compatibility in one recursive walk.
export function cleanJSONSchemaForAntigravity(schema) {
  if (!schema || typeof schema !== "object") return schema;

  function visit(obj) {
    if (!obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      for (const item of obj) visit(item);
      return;
    }

    if (obj.const !== undefined && !obj.enum) {
      obj.enum = [obj.const];
      delete obj.const;
    }
    if (Array.isArray(obj.enum)) {
      obj.enum = obj.enum.map(v => String(v));
      if (!obj.type) obj.type = "string";
    }
    mergeAllOf(obj);
    flattenAnyOfOneOf(obj);
    if (Array.isArray(obj.type)) {
      const nonNullTypes = obj.type.filter(t => t !== "null");
      obj.type = nonNullTypes.length > 0 ? nonNullTypes[0] : "string";
    }
    if (obj.properties && !obj.type) obj.type = "object";
    for (const key of Object.keys(obj)) {
      if (UNSUPPORTED_SCHEMA_CONSTRAINTS.includes(key) || key.startsWith("x-")) delete obj[key];
    }
    cleanupRequired(obj);
    // properties is a NAME->schema map, not a schema node: visit each member schema
    // without ever treating the map itself as a node (an empty map would otherwise
    // match the empty-object branch in addPlaceholder and get rewritten as a schema).
    for (const [key, value] of Object.entries(obj)) {
      if (key === "properties") {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          for (const propSchema of Object.values(value)) visit(propSchema);
        }
        continue;
      }
      visit(value);
    }
    addPlaceholder(obj);
  }

  visit(schema);
  antigravityCleanedSchemas.add(schema);
  return schema;
}
