// External fixed-runtime HTTP proxy: CONNECT tunneling (HTTPS) + absolute-form forward (HTTP).
// Always Node. Prints PORT <n> on stdout. GET /__stats, GET /__reset.
import http from "node:http";
import net from "node:net";

let stats = { connects: 0, tunnelsActive: 0, tunneledBytes: 0, forwarded: 0, forwardedReqBytes: 0, forwardedResBytes: 0, refused: 0 };

const server = http.createServer((req, res) => {
  if (req.url && req.url.startsWith("http://")) {
    stats.forwarded++;
    const u = new URL(req.url);
    const preq = http.request({ host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: req.method, headers: Object.assign({}, req.headers, { host: u.host }) }, (pres) => {
      res.writeHead(pres.statusCode, pres.headers);
      pres.on("data", (c) => { stats.forwardedResBytes += c.length; });
      pres.pipe(res);
    });
    preq.on("error", () => { stats.refused++; try { res.writeHead(502); res.end(); } catch {} });
    req.on("data", (c) => { stats.forwardedReqBytes += c.length; preq.write(c); });
    req.on("end", () => preq.end());
    req.on("aborted", () => preq.destroy());
    return;
  }
  if (req.url === "/__stats") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(stats)); return; }
  if (req.url === "/__reset") { stats = { connects: 0, tunnelsActive: 0, tunneledBytes: 0, forwarded: 0, forwardedReqBytes: 0, forwardedResBytes: 0, refused: 0 }; res.writeHead(200); res.end("ok"); return; }
  res.writeHead(404); res.end();
});

server.on("connect", (req, clientSocket, head) => {
  const parts = req.url.split(":");
  const host = parts[0];
  const port = Number(parts[1] || 443);
  stats.connects++;
  const up = net.connect(port, host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    stats.tunnelsActive++;
    if (head && head.length) { stats.tunneledBytes += head.length; up.write(head); }
    up.on("data", (c) => { stats.tunneledBytes += c.length; });
    clientSocket.on("data", (c) => { stats.tunneledBytes += c.length; });
    up.pipe(clientSocket);
    clientSocket.pipe(up);
    let closed = false;
    const bye = () => {
      if (closed) return;
      closed = true;
      stats.tunnelsActive = Math.max(0, stats.tunnelsActive - 1);
      try { up.destroy(); } catch {}
      try { clientSocket.destroy(); } catch {}
    };
    up.on("close", bye); clientSocket.on("close", bye);
    up.on("error", bye); clientSocket.on("error", bye);
  });
  up.on("error", () => {
    stats.refused++;
    try { clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n"); clientSocket.destroy(); } catch {}
  });
});

server.listen(0, "127.0.0.1", () => process.stdout.write("PORT " + server.address().port + "\n"));
