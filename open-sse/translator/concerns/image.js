// Build a base64 data URI from mime + base64 payload
export function encodeDataUri(mimeType, base64) {
  return `data:${mimeType};base64,${base64}`;
}

// Parse a base64 data URI → { mimeType, base64 }, or null if not a data URI.
// [\s\S] tolerates newlines inside the base64 payload.
const DATA_URI_RE = /^data:([^;]+);base64,([\s\S]+)$/;
export function parseDataUri(url) {
  if (typeof url !== "string") return null;
  const m = url.match(DATA_URI_RE);
  return m ? { mimeType: m[1], base64: m[2] } : null;
}

import { lookup } from "node:dns/promises";
import { Agent } from "undici";
import http from "node:http";
import https from "node:https";
import { MAX_IMAGE_BYTES, FETCH_TIMEOUT_MS, IMAGE_SIGNATURES, BLOCKED_HOSTS } from "../../config/mediaConfig.js";

const IS_BUN = typeof globalThis.Bun !== "undefined";

// Single shared dispatcher for all image fetches (previously one Agent per fetch).
// Its connect.lookup re-validates and pins the resolved IP at connect time,
// preserving the SSRF/TOCTOU guard without per-request Agent churn.
// Node-only: under Bun both global fetch and npm undici ignore the
// dispatcher option and connect.lookup, so the Bun path uses node:http(s).request.
const imageDispatcher = new Agent({
  connect: {
    lookup: (hostname, _options, callback) => {
      resolvePinnedIps(hostname)
        .then((ips) => {
          if (!ips) { callback(new Error("blocked host")); return; }
          callback(null, [{ address: ips[0].address, family: ips[0].family }]);
        })
        .catch((err) => callback(err));
    },
  },
});

// True if an IPv4/IPv6 address is private/reserved (SSRF target).
function isPrivateIp(ip) {
  if (!ip) return true;
  // IPv6 loopback / unique-local / link-local
  if (ip === "::1" || ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80")) return true;
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) -> extract tail
  const v4 = ip.includes(".") ? ip.split(":").pop() : ip;
  const parts = v4.split(".").map((n) => Number.parseInt(n, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return ip.includes(":") ? false : true;
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

// Resolve host once and return only public IPs (SSRF guard).
// Rejects if any resolved record is private/reserved (defeats multi-A tricks).
async function resolvePinnedIps(hostname) {
  if (!hostname || BLOCKED_HOSTS.has(hostname.toLowerCase())) return null;
  try {
    const records = await lookup(hostname, { all: true });
    if (!records.length || records.some((r) => isPrivateIp(r.address))) return null;
    return records;
  } catch {
    return null;
  }
}

// Verify buffer magic bytes match a known image signature; return its mime or null.
function detectImageMime(buf) {
  for (const { sig, offset, mime, verifyWebp } of IMAGE_SIGNATURES) {
    if (buf.length < offset + sig.length) continue;
    let match = true;
    for (let i = 0; i < sig.length; i++) {
      if (buf[offset + i] !== sig[i]) { match = false; break; }
    }
    if (!match) continue;
    // WEBP: RIFF....WEBP — bytes 8..11 must be "WEBP".
    if (verifyWebp && !(buf.length >= 12 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50)) continue;
    return mime;
  }
  return null;
}

// Bun path: fetch+dispatcher cannot pin DNS there, but node:http(s).request
// honors options.lookup under Bun 1.4.1 (verified). Same SSRF guarantees:
// connect-time re-validation via resolvePinnedIps, no redirect following
// (node:http(s) never follows redirects), byte cap applied by the reader.
function pinnedImageRequest(url, signal) {
  return new Promise((resolve) => {
    let req;
    try {
      const lib = url.protocol === "https:" ? https : http;
      req = lib.request(
        {
          hostname: url.hostname,
          port: url.port || (url.protocol === "https:" ? 443 : 80),
          path: url.pathname + url.search,
          method: "GET",
          servername: url.protocol === "https:" ? url.hostname : undefined,
          lookup: (hostname, _options, callback) => {
            resolvePinnedIps(hostname)
              .then((ips) => {
                if (!ips) { callback(new Error("blocked host")); return; }
                callback(null, [{ address: ips[0].address, family: ips[0].family }]);
              })
              .catch(callback);
          },
        },
        (res) => resolve(res)
      );
    } catch { resolve(null); return; }
    signal.addEventListener("abort", () => req.destroy(), { once: true });
    req.on("error", () => resolve(null));
    req.end();
  });
}

// Read a node stream body with a hard byte cap; null on error or overflow.
function readBodyWithCap(stream, maxBytes) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    stream.on("data", (c) => {
      total += c.length;
      if (total > maxBytes) { stream.destroy(); resolve(null); return; }
      chunks.push(c);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", () => resolve(null));
  });
}

function bufToResult(buf) {
  const mimeType = detectImageMime(buf);
  if (!mimeType) return null; // not a recognized image — reject disguised payloads
  return { url: "data:" + mimeType + ";base64," + buf.toString("base64"), mimeType };
}

/**
 * Fetch a remote image URL and return it as a base64 data URI.
 * Hardened against SSRF (private/metadata IPs), memory DoS (size cap),
 * and disguised non-image payloads (magic-byte verification).
 * Returns null on any failure or rejection.
 *
 * @param {string} imageUrl - HTTP(S) URL of the image
 * @param {object} options - { signal, timeoutMs, maxBytes }
 * @returns {Promise<{url: string, mimeType: string}|null>}
 */
export async function fetchImageAsBase64(imageUrl, options = {}) {
  const { signal, timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_IMAGE_BYTES } = options;
  if (!imageUrl || (!imageUrl.startsWith("http://") && !imageUrl.startsWith("https://"))) {
    return null;
  }

  let url;
  try { url = new URL(imageUrl); } catch { return null; }
  if (!await resolvePinnedIps(url.hostname)) return null;

  const controller = new AbortController();
  const timeout = signal ? null : setTimeout(() => controller.abort(), timeoutMs);
  const fetchSignal = signal || controller.signal;

  try {
    if (IS_BUN) {
      // Bun: fetch+dispatcher cannot pin DNS — node:http(s).request with
      // connect-time resolvePinnedIps lookup (Bun honors options.lookup);
      // node request never follows redirects, so redirect-SSRF stays covered.
      const res = await pinnedImageRequest(url, fetchSignal);
      if (!res || res.statusCode < 200 || res.statusCode >= 300) { res?.destroy?.(); return null; }
      const buf = await readBodyWithCap(res, maxBytes);
      if (!buf) return null;
      return bufToResult(buf);
    }

    // Node: redirect:"manual" prevents a public URL redirecting to a private one (SSRF bypass).
    // Connect is pinned to the validated IP by the shared dispatcher's lookup.
    const response = await fetch(imageUrl, { signal: fetchSignal, redirect: "manual", dispatcher: imageDispatcher });
    if (!response.ok || !response.body) return null;

    // Stream-read with a hard byte cap to avoid loading huge payloads into memory.
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) { try { await reader.cancel(); } catch { /* ignore */ } return null; }
      chunks.push(value);
    }

    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    const mimeType = detectImageMime(buf);
    if (!mimeType) return null; // not a recognized image — reject disguised payloads

    return { url: `data:${mimeType};base64,${buf.toString("base64")}`, mimeType };
  } catch {
    return null;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
