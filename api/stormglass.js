const fetch = require("node-fetch");

const LATITUDE = 36.9583;
const LONGITUDE = -122.0170;
const MAX_PAST_DAYS = 30;
const MAX_FUTURE_DAYS = 7;

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Expose-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
}

function parseDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
  return date;
}

function isWithinSupportedRange(date, now = new Date()) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const selected = date.getTime();
  const min = today - MAX_PAST_DAYS * 86400000;
  const max = today + MAX_FUTURE_DAYS * 86400000;
  return selected >= min && selected <= max;
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).send("Method not allowed");

  const date = parseDate(req.query?.date);
  if (!date || !isWithinSupportedRange(date)) {
    return res.status(400).send("Invalid or unsupported date");
  }

  const apiKey = process.env.STORMGLASS_API_KEY;
  if (!apiKey) return res.status(503).send("Storm Glass is not configured");

  const start = Math.floor(date.getTime() / 1000);
  const end = start + 24 * 3600;
  const upstreamUrl = new URL("https://api.stormglass.io/v2/tide/point");
  upstreamUrl.search = new URLSearchParams({
    lat: String(LATITUDE),
    lng: String(LONGITUDE),
    start: String(start),
    end: String(end)
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const upstream = await fetch(upstreamUrl, {
      headers: { Authorization: apiKey },
      signal: controller.signal
    });
    const body = await upstream.text();
    res.status(upstream.status);
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
    return res.send(body);
  } catch (error) {
    console.error("stormglass.js error:", error);
    return res.status(error.name === "AbortError" ? 504 : 502).send("Storm Glass request failed");
  } finally {
    clearTimeout(timeout);
  }
};

module.exports._test = { parseDate, isWithinSupportedRange };
