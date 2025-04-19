const fetch = require("node-fetch");

module.exports = async (req, res) => {
  // CORS & Range support
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Range, Content-Type");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") return res.status(200).end();

  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send("Missing 'url' query param");

  try {
    // Forward any Range
    const upstream = await fetch(decodeURIComponent(targetUrl), {
      method: "GET",
      headers: req.headers.range ? { Range: req.headers.range } : {},
      redirect: "follow",
      compress: false
    });

    // Mirror status
    res.status(upstream.status);

    // Copy headers (minus hop‑by‑hop / compression)
    upstream.headers.forEach((v, k) => {
      const lk = k.toLowerCase();
      if (lk === "transfer-encoding" || lk === "content-encoding") return;
      res.setHeader(k, v);
    });
    // Re‑set CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Range, Content-Type");
    res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");

    // If it's a manifest, rewrite it
    if (targetUrl.toLowerCase().endsWith(".m3u8") ||
        (upstream.headers.get("content-type")||"").includes("mpegurl")) {
      const text = await upstream.text();
      const base = decodeURIComponent(targetUrl);
      // Every line not starting with "#" becomes absolute
      const fixed = text.replace(
        /^(?!#)(\S+)/gm,
        (_, uri) => new URL(uri, base).toString()
      );
      // Send it back as text
      return res
        .setHeader("Content-Type", "application/vnd.apple.mpegurl")
        .send(fixed);
    }

    // Otherwise just stream the bytes
    upstream.body.pipe(res);
  } catch (err) {
    console.error("proxy error:", err);
    res.status(500).send("Proxy fetch error");
  }
};