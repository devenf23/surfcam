const fetch = require("node-fetch");

module.exports = async (req, res) => {
  // 1) Always set CORS & Range headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Range, Content-Type");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  // 2) Handle preflight
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // 3) Validate
  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).send("Missing 'url' query parameter.");
  }

  try {
    // 4) Forward Range headers if present
    const headers = {
      "User-Agent": "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N)"
    };
    if (req.headers.range) {
      headers.Range = req.headers.range;
    }

    // 5) Fetch upstream
    const upstream = await fetch(targetUrl, {
      method: "GET",
      headers,
      redirect: "follow",
      compress: false
    });

    // 6) Mirror status
    res.status(upstream.status);

    // 7) Copy all headers except hop‑by‑hop/compression
    upstream.headers.forEach((value, key) => {
      const k = key.toLowerCase();
      if (k === "transfer-encoding" || k === "content-encoding") return;
      res.setHeader(key, value);
    });

    // 8) Re‑set CORS (in case upstream overwrote)
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Range, Content-Type");
    res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");

    // 9) Pipe data
    upstream.body.pipe(res);
  } catch (err) {
    console.error("proxy.js error:", err);
    res.status(500).send("Error fetching target URL.");
  }
};