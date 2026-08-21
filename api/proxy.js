const dns = require("node:dns").promises;
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const fetch = require("node-fetch");

const MAX_REDIRECTS = 20;
const HEADER_TIMEOUT_MS = 20000;

// The proxy is intentionally public, but it must not become a way to reach
// loopback, cloud metadata, private, or otherwise reserved networks.
const blockedNetworks = new net.BlockList();
[
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4]
].forEach(([address, prefix]) => blockedNetworks.addSubnet(address, prefix, "ipv4"));
[
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
  ["2001:db8::", 32], ["2001:10::", 28]
].forEach(([address, prefix]) => blockedNetworks.addSubnet(address, prefix, "ipv6"));

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Range, Content-Type");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
}

function parseTarget(value) {
  if (Array.isArray(value)) value = value[0];
  if (typeof value !== "string" || !value) throw new Error("Missing 'url' query param");
  const target = new URL(value);
  if (!/^https?:$/.test(target.protocol)) throw new Error("Only HTTP(S) URLs are supported");
  if (target.username || target.password) throw new Error("Credentialed URLs are not supported");
  return target;
}

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (!family) return false;
  if (family === 6 && address.toLowerCase().startsWith("::ffff:")) {
    const mapped = address.slice(address.lastIndexOf(":") + 1);
    if (net.isIP(mapped) === 4) return isPublicAddress(mapped);
  }
  return !blockedNetworks.check(address, family === 4 ? "ipv4" : "ipv6");
}

async function resolvePublicAddress(url) {
  const records = await dns.lookup(url.hostname, { all: true, verbatim: true });
  const publicRecords = records.filter(record => isPublicAddress(record.address));
  if (!records.length || publicRecords.length !== records.length) {
    throw new Error("Target resolves to a non-public address");
  }
  return publicRecords[0];
}

function createPinnedAgent(url, record) {
  const Agent = url.protocol === "https:" ? https.Agent : http.Agent;
  return new Agent({
    lookup(_hostname, _options, callback) {
      callback(null, record.address, record.family);
    }
  });
}

async function fetchWithValidatedRedirects(initialUrl, options) {
  let url = parseTarget(initialUrl);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const record = await resolvePublicAddress(url);
    const response = await fetch(url, {
      ...options,
      agent: createPinnedAgent(url, record),
      redirect: "manual"
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url };
    const location = response.headers.get("location");
    if (!location) return { response, url };
    if (response.body) response.body.destroy();
    url = parseTarget(new URL(location, url).toString());
  }
  throw new Error("Too many redirects");
}

function absoluteUri(value, base) {
  try {
    return new URL(value, base).toString();
  } catch {
    return value;
  }
}

function rewriteManifest(text, base) {
  const lines = text.split(/(\r?\n)/);
  for (let index = 0; index < lines.length; index += 2) {
    const line = lines[index];
    if (!line || line.trimStart().startsWith("#")) continue;
    const leading = line.match(/^\s*/)[0];
    lines[index] = leading + absoluteUri(line.trim(), base);
  }
  return lines.join("").replace(/(URI=)(["'])([^"']+)\2/g, (_match, key, quote, value) => {
    return `${key}${quote}${absoluteUri(value, base)}${quote}`;
  });
}

function copyHeaders(upstream, res) {
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === "transfer-encoding" || lower === "content-encoding" || lower === "content-length") return;
    res.setHeader(key, value);
  });
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).send("Method not allowed");

  let target;
  try {
    target = parseTarget(req.query?.url);
  } catch (error) {
    return res.status(400).send(error.message);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEADER_TIMEOUT_MS);
  const abortOnDisconnect = () => controller.abort();
  const cleanupRequest = () => {
    req.removeListener?.("aborted", abortOnDisconnect);
    req.removeListener?.("close", abortOnDisconnect);
  };
  req.once?.("aborted", abortOnDisconnect);
  req.once?.("close", abortOnDisconnect);
  let streaming = false;

  try {
    const headers = {
      "User-Agent": req.headers["user-agent"] || "Mozilla/5.0",
      Referer: "https://www.surfline.com/",
      Origin: "https://www.surfline.com/"
    };
    if (req.headers.range) headers.Range = req.headers.range;

    const { response: upstream, url: finalUrl } = await fetchWithValidatedRedirects(target.toString(), {
      method: "GET",
      headers,
      compress: false,
      signal: controller.signal
    });
    clearTimeout(timeout);
    copyHeaders(upstream, res);
    res.status(upstream.status);
    setCors(res);

    const contentType = upstream.headers.get("content-type") || "";
    if (finalUrl.pathname.toLowerCase().endsWith(".m3u8") || contentType.toLowerCase().includes("mpegurl")) {
      const text = await upstream.text();
      const rewritten = rewriteManifest(text, finalUrl.toString());
      res.removeHeader("Content-Length");
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      return res.send(rewritten);
    }

    if (!upstream.body) return res.end();
    streaming = true;
    const cleanupStream = () => {
      cleanupRequest();
      res.removeListener?.("finish", cleanupStream);
      res.removeListener?.("close", cleanupStream);
    };
    res.once?.("finish", cleanupStream);
    res.once?.("close", cleanupStream);
    upstream.body.on("error", error => {
      console.error("proxy upstream stream error:", error);
      if (!res.headersSent) res.status(502).send("Upstream stream failed");
      else res.destroy(error);
    });
    return upstream.body.pipe(res);
  } catch (error) {
    clearTimeout(timeout);
    console.error("proxy.js error:", error);
    if (res.headersSent) return res.destroy(error);
    return res.status(error.name === "AbortError" ? 504 : 502).send("Error fetching target URL.");
  } finally {
    if (!streaming) cleanupRequest();
  }
};

module.exports._test = { isPublicAddress, parseTarget, rewriteManifest };
