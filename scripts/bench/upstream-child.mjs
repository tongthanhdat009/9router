// Standalone HTTPS (or HTTP via UPSTREAM_MODE=http) SSE upstream interference isolation (prints port on stdout).
import fs from "node:fs";
import http from "node:http";
import https from "node:https";

const [, , keyFile, certFile] = process.argv;
const mode = process.env.UPSTREAM_MODE === "http" ? "http" : "https";
if (mode === "https" && (!keyFile || !certFile)) { process.stderr.write("usage: upstream-child.mjs <key> <cert>\n"); process.exit(2); }

function handler(req, res) {
  let bytes = 0;
  req.on("data", (c) => { bytes += c.length; });
  req.on("end", () => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "x-upload-ms": String(Date.now() - req.socket._reqStart || 0),
      "x-received-bytes": String(bytes),
    });
    res.write('data: {"choices":[{"delta":{"content":"ok"}}]}' + '\n\n');
    res.write("data: [DONE]\n\n");
    res.end();
  });
  req.on("error", () => { try { res.destroy(); } catch {} });
}

const server = mode === "http"
  ? http.createServer(handler)
  : https.createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }, handler);
server.on("tlsClientError", (err) => process.stderr.write("tlsClientError: " + err.message + "\n"));
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(String(server.address().port) + "\n");
});
