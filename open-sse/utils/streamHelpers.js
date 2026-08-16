import { FORMATS } from "../translator/formats.js";

// Parse SSE data line
export function parseSSELine(line, format = null) {
  if (!line) return null;

  // NDJSON format (Ollama): raw JSON lines without "data:" prefix
  if (format === FORMATS.OLLAMA) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{")) {
      try {
        return JSON.parse(trimmed);
      } catch (error) {
        return null;
      }
    }
    return null;
  }

  // Standard SSE format: "data: {...}"
  if (line.charCodeAt(0) !== 100) return null; // 'd' = 100

  const data = line.slice(5).trim();
  if (data === "[DONE]") return { done: true };

  try {
    return JSON.parse(data);
  } catch (error) {
    if (data.length > 0 && data.length < 1000) {
      console.log(`[WARN] Failed to parse SSE line (${data.length} chars): ${data.substring(0, 100)}...`);
    }
    return null;
  }
}

// Check if chunk has valuable content (not empty)
export function hasValuableContent(chunk, format) {
  // OpenAI format
  if (format === FORMATS.OPENAI && chunk.choices?.[0]?.delta) {
    const delta = chunk.choices[0].delta;
    return delta.content && delta.content !== "" ||
           delta.reasoning_content && delta.reasoning_content !== "" ||
           delta.tool_calls && delta.tool_calls.length > 0 ||
           chunk.choices[0].finish_reason ||
           delta.role;
  }

  // Claude format
  if (format === FORMATS.CLAUDE) {
    const isContentBlockDelta = chunk.type === "content_block_delta";
    const hasText = chunk.delta?.text && chunk.delta.text !== "";
    const hasThinking = chunk.delta?.thinking && chunk.delta.thinking !== "";
    const hasInputJson = chunk.delta?.partial_json && chunk.delta.partial_json !== "";
    
    if (isContentBlockDelta && !hasText && !hasThinking && !hasInputJson) {
      return false;
    }
    return true;
  }

  return true; // Other formats: keep all chunks
}

// OpenAI Responses streaming events that carry model-generated semantic output
const OPENAI_RESPONSES_SEMANTIC_EVENT_TYPES = new Set([
  "response.output_text.delta",
  "response.reasoning_summary_text.delta",
  "response.function_call_arguments.delta",
  "response.custom_tool_call_input.delta",
]);

// Responses same-format passthrough variant of hasSemanticGenerationDelta:
// event identity comes from the SSE `event:` frame (or chunk.type), payload carries `delta` string
export function hasOpenAIResponsesSemanticGenerationDelta(eventName, chunk) {
  const type = eventName || (typeof chunk?.type === "string" ? chunk.type : null);
  return OPENAI_RESPONSES_SEMANTIC_EVENT_TYPES.has(type) &&
    typeof chunk?.delta === "string" && chunk.delta.length > 0;
}

export function hasSemanticGenerationDelta(chunk) {
  const delta = chunk?.choices?.[0]?.delta;
  if (delta) {
    if (typeof delta.content === "string" && delta.content.length > 0) return true;
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) return true;
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.some((call) =>
      [call?.id, call?.function?.name, call?.function?.arguments].some((value) => typeof value === "string" && value.length > 0))) return true;
  }
  if (typeof chunk?.delta?.text === "string" && chunk.delta.text.length > 0) return true;
  if (typeof chunk?.delta?.thinking === "string" && chunk.delta.thinking.length > 0) return true;
  if (typeof chunk?.delta?.partial_json === "string" && chunk.delta.partial_json.length > 0) return true;
  return chunk?.candidates?.[0]?.content?.parts?.some((part) => typeof part?.text === "string" && part.text.length > 0) || false;
}

// Fix invalid id (generic or too short)
export function fixInvalidId(parsed) {
  if (parsed.id && (parsed.id === "chat" || parsed.id === "completion" || parsed.id.length < 8)) {
    const fallbackId = parsed.extend_fields?.requestId || 
                      parsed.extend_fields?.traceId || 
                      Date.now().toString(36);
    parsed.id = `chatcmpl-${fallbackId}`;
    return true;
  }
  return false;
}

function cleanUsagePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }

  let cleaned = payload;

  if ("usage" in cleaned) {
    if (cleaned.usage === null) {
      const { usage, ...payloadWithoutUsage } = cleaned;
      cleaned = payloadWithoutUsage;
    } else if (typeof cleaned.usage === "object" && cleaned.usage.perf_metrics === null) {
      const { perf_metrics, ...usageWithoutPerf } = cleaned.usage;
      cleaned = { ...cleaned, usage: usageWithoutPerf };
    }
  }

  if (cleaned.response && typeof cleaned.response === "object" && !Array.isArray(cleaned.response)) {
    const cleanedResponse = cleanUsagePayload(cleaned.response);
    if (cleanedResponse !== cleaned.response) {
      cleaned = { ...cleaned, response: cleanedResponse };
    }
  }

  return cleaned;
}

// Format output as SSE
export function formatSSE(data, sourceFormat) {
  if (data === null || data === undefined) return "data: null\n\n";
  if (data && data.done) return "data: [DONE]\n\n";

  // OpenAI Responses API format
  if (data && data.event && data.data) {
    const cleanedEventData = cleanUsagePayload(data.data);
    return `event: ${data.event}\ndata: ${JSON.stringify(cleanedEventData)}\n\n`;
  }

  data = cleanUsagePayload(data);

  // Claude format
  if (sourceFormat === FORMATS.CLAUDE && data && data.type) {
    return `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  return `data: ${JSON.stringify(data)}\n\n`;
}
