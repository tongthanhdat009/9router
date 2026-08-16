#!/usr/bin/env node
const baseUrl = process.env.BASE_URL;
const apiKey = process.env.API_KEY;
if (!baseUrl || !apiKey) {
  console.error("BASE_URL and API_KEY required");
  process.exit(2);
}
const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/responses`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
  body: JSON.stringify({ model: process.env.MODEL || "codex/gpt-5.3-codex", input: "Reply: ok", stream: true }),
});
console.log(`status=${response.status} content-type=${response.headers.get("content-type") || ""}`);
if (!response.ok) process.exit(1);
const reader = response.body?.getReader();
const first = reader && await reader.read();
console.log(first?.value ? new TextDecoder().decode(first.value).slice(0, 300) : "no stream event");
await reader?.cancel();
