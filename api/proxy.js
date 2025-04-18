// proxy.js
const express = require('express');
const fetch = require('node-fetch');   // Make sure you've run: npm install node-fetch
const { Buffer } = require('buffer');

const app = express();
const PORT = 3000;  // port for your proxy server

app.get('/api/proxy', async (req, res) => {
// Set the CORS header immediately.
res.setHeader("Access-Control-Allow-Origin", "*");

const { url } = req.query;
if (!url) {
res.status(400).json({ error: "Missing url query parameter." });
return;
}
try {
const response = await fetch(url, {
headers: {
"User-Agent": "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N)"
}
});
const contentType = response.headers.get("content-type") || "application/octet-stream";
res.setHeader("Content-Type", contentType);
const data = await response.arrayBuffer();
res.status(response.status).send(Buffer.from(data));
} catch (err) {
console.error("Proxy error:", err);
res.status(500).json({ error: "Error occurred in proxy." });
}
});

  app.listen(PORT, () => {
     console.log("Proxy server running at http://localhost:" + PORT);
    });