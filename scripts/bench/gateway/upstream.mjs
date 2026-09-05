// External fixed-runtime OpenAI-compatible SSE upstream for full-gateway benchmarks.
// Always Node (never Bun): upstream side is the fixed reference runtime.
// Prints PORT <n> on stdout. GET /__stats -> counters. GET /__reset -> zero counters.
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import { createHash } from "node:crypto";

const tls = process.env.UPSTREAM_TLS === "1";
const chunks = Number(process.env.UPSTREAM_CHUNKS || 8);
const id = process.env.UPSTREAM_ID || "up";
let stats = { id: id, requests: 0, bytesReceived: 0, aborted: 0, arrivalMs: [], last: null };

function chunk(delta, finish) {
  return "data: " + JSON.stringify({ id: "chatcmpl-bench", object: "chat.completion.chunk", choices: [{ index: 0, delta: delta, finish_reason: finish }] }) + "\n\n";
}

function handler(req, res) {
  if (req.method === "GET" && req.url === "/__stats") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(stats));
    return;
  }
  if (req.method === "GET" && req.url === "/__reset") {
    stats = { id: id, requests: 0, bytesReceived: 0, aborted: 0, arrivalMs: [], last: null };
    res.writeHead(200); res.end("ok");
    return;
  }
  let bytes = 0;
  const chunks = [];
  let finished = false;
  const t0 = Date.now();
  stats.requests++;
  req.on("data", (c) => { if (!finished) { bytes += c.length; chunks.push(c); } });
  req.on("aborted", () => {
    if (finished) return;
    finished = true; stats.aborted++;
    try { res.destroy(); } catch {}
  });
  req.on("end", () => {
    if (finished) return;
    finished = true;
    stats.bytesReceived += bytes;
    stats.arrivalMs.push(Date.now() - t0);
    // Semantic identity of the last received body: byte-exact sha256 + observed model field.
    const body = Buffer.concat(chunks);
    const canon = (o) => Array.isArray(o) ? "[" + o.map(canon).join(",") + "]" : (o && typeof o === "object") ? "{" + Object.keys(o).sort().map(k => JSON.stringify(k) + ":" + canon(o[k])).join(",") + "}" : JSON.stringify(o);
    const last = { bytes, sha256: createHash("sha256").update(body).digest("hex"), canonicalSha256: null, model: null };
    try { const parsed = JSON.parse(body); last.model = parsed.model || null; last.canonicalSha256 = createHash("sha256").update(canon(parsed)).digest("hex"); } catch {}
    stats.last = last;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "x-received-bytes": String(bytes) });
    let i = 0;
    const send = () => {
      if (i < chunks) {
        res.write(chunk({ content: "x".repeat(64) }, null));
        i++; setImmediate(send);
      } else {
        res.write(chunk({}, "stop"));
        res.write("data: [DONE]" + "\n\n");
        res.end();
      }
    };
    send();
  });
  req.on("error", () => { try { res.destroy(); } catch {} });
}

const server = tls
  ? https.createServer({ key: fs.readFileSync(process.env.UPSTREAM_KEY), cert: fs.readFileSync(process.env.UPSTREAM_CERT) }, handler)
  : http.createServer(handler);
server.listen(0, "127.0.0.1", () => process.stdout.write("PORT " + server.address().port + "\n"));
