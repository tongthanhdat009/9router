// OpenCode Console validates JSON Schema patterns with RE2. JavaScript accepts
// lookaround syntax that RE2 rejects, so omit only those optional constraints.
export function removeUnsupportedConsoleRegexPatterns(schema, seen = new WeakSet()) {
  if (!schema || typeof schema !== "object" || seen.has(schema)) return;
  seen.add(schema);

  if (typeof schema.pattern === "string") {
    try {
      new RegExp(schema.pattern, "u");
      if (/\(\?(?:=|!|<=|<!)/.test(schema.pattern)) delete schema.pattern;
    } catch {
      delete schema.pattern;
    }
  }

  for (const value of Object.values(schema)) {
    if (Array.isArray(value)) {
      for (const item of value) removeUnsupportedConsoleRegexPatterns(item, seen);
    } else {
      removeUnsupportedConsoleRegexPatterns(value, seen);
    }
  }
}

export function sanitizeConsoleResponsesToolSchemas(body) {
  if (!Array.isArray(body?.tools)) return;
  for (const tool of body.tools) {
    if (tool?.type === "function") removeUnsupportedConsoleRegexPatterns(tool.parameters);
  }
}
