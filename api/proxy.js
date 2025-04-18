// File: api/proxy.js

const fetch = require("node-fetch");

module.exports = async (req, res) => {
// Always allow GitHub Pages (or any origin) to access the response
res.setHeader("Access-Control-Allow-Origin", "*");
res.setHeader("Vary", "Origin");

// Handle preflight OPTIONS request if necessary
if (req.method === "OPTIONS") {
res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
res.setHeader("Access-Control-Allow-Headers", "Content-Type");
return res.status(200).end();
}

// Get the target URL from query parameters.
const targetUrl = req.query.url;
if (!targetUrl) {
return res.status(400).send("Missing 'url' query parameter.");
}

try {
// Set up fetch options with the custom User-Agent header.
const fetchOptions = {
headers: {
"User-Agent": "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N)"
}
};

// Initiate the request to the target URL
const response = await fetch(targetUrl, fetchOptions);

// Pass along status code from the remote response
res.status(response.status);

// Forward content-type (or default if missing)
const contentType = response.headers.get("content-type") || "application/octet-stream";
res.setHeader("Content-Type", contentType);

// Pipe the remote response stream directly to the client.
response.body.pipe(res);
} catch (error) {
console.error("proxy.js error:", error);
res.status(500).send("Error fetching target URL.");
}
};