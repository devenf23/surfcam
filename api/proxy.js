const fetch = require("node-fetch");

module.exports = async (req, res) => {
// Always set CORS headers first
res.setHeader("Access-Control-Allow-Origin", "*");
res.setHeader("Vary", "Origin");

// Handle OPTIONS requests
if (req.method === "OPTIONS") {
res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
res.setHeader("Access-Control-Allow-Headers", "Content-Type");
return res.status(200).end();
}

// Get the target URL from query parameters.
const targetUrl = req.query.url;
if (!targetUrl) {
// Include the header even in error responses
return res.status(400).send("Missing 'url' query parameter.");
}

try {
const fetchOptions = {
headers: {
"User-Agent": "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N)"
}
};

const response = await fetch(targetUrl, fetchOptions);

// Forward the remote response's status code
res.status(response.status);

// Set the content-type from the remote response
const contentType = response.headers.get("content-type") || "application/octet-stream";
res.setHeader("Content-Type", contentType);

// Pipe the response stream to the client.
response.body.pipe(res);
} catch (error) { console.error("proxy.js error:", error); return res.status(500).send("Error fetching target URL."); } };