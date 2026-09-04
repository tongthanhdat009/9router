import { describe, it, expect, afterAll } from "vitest";
import { proxyAwareFetch, proxyDispatchers } from "../../open-sse/utils/proxyFetch.js";
import { testProxyUrl } from "../../src/lib/network/proxyTest.js";
import http from "node:http";
import net from "node:net";

describe("Bun & Node proxy compatibility", () => {
  let proxyServer;
  let targetServer;
  let proxyUrl;
  let targetUrl;
  let connectHits = 0;
  let httpHits = 0;

  afterAll(async () => {
    for (const d of proxyDispatchers.values()) await d?.close?.();
    proxyServer?.close?.();
    targetServer?.close?.();
  });

  it("sets up mock target and connect proxy", async () => {
    targetServer = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ target: true }));
    });
    await new Promise((r) => targetServer.listen(0, "127.0.0.1", r));
    targetUrl = "http://127.0.0.1:" + targetServer.address().port + "/test";

    proxyServer = http.createServer((req, res) => {
      httpHits++;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("proxied-http");
    });
    proxyServer.on("connect", (req, client, head) => {
      connectHits++;
      const [host, rawPort] = req.url.split(":");
      const target = net.connect(Number(rawPort), host, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) target.write(head);
        target.pipe(client);
        client.pipe(target);
      });
      target.on("error", () => client.destroy());
      client.on("error", () => target.destroy());
    });
    await new Promise((r) => proxyServer.listen(0, "127.0.0.1", r));
    proxyUrl = "http://127.0.0.1:" + proxyServer.address().port;

    expect(proxyUrl).toBeTruthy();
    expect(targetUrl).toBeTruthy();
  });

  it("routes through live mock proxy via proxyAwareFetch", async () => {
    const res = await proxyAwareFetch(targetUrl, {}, { enabled: true, url: proxyUrl, strictProxy: true });
    expect(res.status).toBe(200);
    expect(connectHits + httpHits).toBeGreaterThan(0);
  });

  it("throws on dead proxy when strictProxy is true", async () => {
    await expect(
      proxyAwareFetch(targetUrl, { signal: AbortSignal.timeout(1000) }, { enabled: true, url: "http://127.0.0.1:59999", strictProxy: true })
    ).rejects.toThrow();
  });

  it("testProxyUrl reports live proxy as ok", async () => {
    const res = await testProxyUrl({ proxyUrl, testUrl: targetUrl, timeoutMs: 3000 });
    expect(res.ok).toBe(true);
  });

  it("testProxyUrl reports dead proxy as not ok", async () => {
    const res = await testProxyUrl({ proxyUrl: "http://127.0.0.1:59999", testUrl: targetUrl, timeoutMs: 2000 });
    expect(res.ok).toBe(false);
  });
});
