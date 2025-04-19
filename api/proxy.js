// /api/proxy.js
const fetch = require("node-fetch");

module.exports = async (req, res) => {
  // CORS + range support (unchanged)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Range, Content-Type");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send("Missing 'url' query param");

  try {
    const decodedUrl = decodeURIComponent(targetUrl);

    // ←— HERE’S THE ONLY ADDITION: add Surfline’s required Referer & Origin
    const upstreamHeaders = {
      "User-Agent": req.headers["user-agent"] || "Mozilla/5.0",
      "Referer":    "https://www.surfline.com/",
      "Origin":     "https://www.surfline.com/"
    };
    if (req.headers.range) {
      upstreamHeaders.Range = req.headers.range;
    }

    const upstream = await fetch(decodedUrl, {
      method: "GET",
      headers: upstreamHeaders,
      redirect: "follow",
      compress: false
    });

    // mirror status & headers
    res.status(upstream.status);
    upstream.headers.forEach((v, k) => {
      const lk = k.toLowerCase();
      if (lk === "transfer-encoding" || lk === "content-encoding") return;
      res.setHeader(k, v);
    });
    // re‑set CORS in case upstream stomped
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Range, Content-Type");
    res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");

    // playlist rewriting (if you have that manifest‐rewrite in place)
    if (decodedUrl.toLowerCase().endsWith(".m3u8")
     || (upstream.headers.get("content-type")||"").includes("mpegurl")) {
      const txt  = await upstream.text();
      const base = decodedUrl;
      const fixed = txt.replace(
        /^(?!#)(\S+)/gm,
        (_, uri) => new URL(uri, base).toString()
      );
      return res
        .setHeader("Content-Type", "application/vnd.apple.mpegurl")
        .send(fixed);
    }

    // otherwise just pipe the segment bytes
    upstream.body.pipe(res);
  } catch (err) {
    console.error("proxy.js error:", err);
    res.status(500).send("Error fetching target URL.");
  }
};