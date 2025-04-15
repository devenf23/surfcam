/* api/proxy.js */
export default async function handler(req, res) {
    const { url } = req.query;
    if (!url) {
      res.status(400).json({ error: "Missing url query parameter." });
      return;
    }
    try {
      // Fetch the target URL using the modified User-Agent header.
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N)"
        }
      });
      // Forward response headers.
      const contentType = response.headers.get("content-type") || "application/octet-stream";
      res.setHeader("Content-Type", contentType);
      // Get the response data as an ArrayBuffer and send it.
      const data = await response.arrayBuffer();
      res.status(response.status).send(Buffer.from(data));
    } catch (err) {
      console.error("Proxy error:", err);
      res.status(500).json({ error: "Error occurred in proxy." });
    }
  }