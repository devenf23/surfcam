/* api/proxy.js */
export default async function handler(req, res) {
    const { url } = req.query;
    if (!url) {
    res.status(400).json({ error: "Missing url query parameter." });
    return;
    }
    try {
    // Forward the request with our desired User-Agent header.
    const response = await fetch(url, {
    headers: {
    "User-Agent": "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N)"
    }
    });
    // Forward the content-type header if available.
    const contentType = response.headers.get("content-type") || "text/plain";
    res.setHeader("Content-Type", contentType);
    // Get response body as an ArrayBuffer, then send it as a Buffer.
    const data = await response.arrayBuffer();
    res.status(response.status).send(Buffer.from(data));
    } catch (error) {
    console.error("Proxy error:", error);
    res.status(500).json({ error: "Error occurred in proxy." });
    }
    }