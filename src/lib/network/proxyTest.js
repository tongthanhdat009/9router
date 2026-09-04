import { ProxyAgent, fetch as undiciFetch } from "undici";

const DEFAULT_TEST_URL = "https://google.com/";
const DEFAULT_TIMEOUT_MS = 8000;

function getErrorMessage(err) {
  if (!err) return "Unknown error";
  const base = err?.message || String(err);
  const causeCode = err?.cause?.code || err?.code;
  const causeMessage = err?.cause?.message;

  if (causeMessage && causeMessage !== base) {
    return causeCode ? `${base}: ${causeMessage} (${causeCode})` : `${base}: ${causeMessage}`;
  }

  if (causeCode && !base.includes(causeCode)) {
    return `${base} (${causeCode})`;
  }

  return base;
}

function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

export async function testProxyUrl({ proxyUrl, testUrl, timeoutMs } = {}) {
  const normalizedProxyUrl = normalizeString(proxyUrl);
  if (!normalizedProxyUrl) {
    return { ok: false, status: 400, error: "proxyUrl is required" };
  }

  const normalizedTestUrl = normalizeString(testUrl) || DEFAULT_TEST_URL;
  const timeoutMsRaw = Number(timeoutMs);
  const normalizedTimeoutMs =
    Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
      ? Math.min(timeoutMsRaw, 30000)
      : DEFAULT_TIMEOUT_MS;

  // Bun's fetch ignores undici's dispatcher option (its npm ProxyAgent is
  // non-functional), which made this test silently connect directly and
  // report dead proxies as OK. Use the native proxy option there instead.
  const isBun = typeof globalThis.Bun !== "undefined";
  let proxyProtocol = "";
  try {
    proxyProtocol = new URL(normalizedProxyUrl).protocol;
  } catch {
    // scheme-less input — let fetch surface the error below
  }
  if (isBun && ["socks4:", "socks4a:", "socks5:", "socks5h:"].includes(proxyProtocol)) {
    return {
      ok: false,
      status: 400,
      error: `Proxy protocol ${proxyProtocol} is not supported under Bun (run under Node or use an http(s) proxy)`,
    };
  }

  let dispatcher;

  try {
    if (!isBun) {
      try {
        dispatcher = new ProxyAgent({ uri: normalizedProxyUrl });
      } catch (err) {
        return {
          ok: false,
          status: 400,
          error: `Invalid proxy URL: ${err?.message || String(err)}`,
        };
      }
    }

    const controller = new AbortController();
    const startedAt = Date.now();
    const timer = setTimeout(() => controller.abort(), normalizedTimeoutMs);

    try {
      const res = await (isBun
        ? fetch(normalizedTestUrl, {
            method: "HEAD",
            proxy: normalizedProxyUrl,
            signal: controller.signal,
            headers: {
              "User-Agent": "9Router",
            },
          })
        : undiciFetch(normalizedTestUrl, {
            method: "HEAD",
            dispatcher,
            signal: controller.signal,
            headers: {
              "User-Agent": "9Router",
            },
          }));

      return {
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        url: normalizedTestUrl,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (err) {
      const message =
        err?.name === "AbortError"
          ? "Proxy test timed out"
          : getErrorMessage(err);
      return { ok: false, status: 500, error: message };
    } finally {
      clearTimeout(timer);
    }
  } finally {
    try {
      await dispatcher?.close?.();
    } catch {
      // ignore
    }
  }
}
