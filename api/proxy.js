// File: api/proxy.js

const fetch = require("node-fetch");

module.exports = async (req, res) => {
// Allow all origins if needed
res.setHeader("Access-Control-Allow-Origin", "*");

// Get the URL from the query parameter.
const targetUrl = req.query.url;
if (!targetUrl) {
return res.status(400).send("Missing 'url' query parameter.");
}

try {
// Set the custom User-Agent header
const fetchOptions = {
headers: {
"User-Agent": "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N)",
}
};

// Initiate the request
const response = await fetch(targetUrl, fetchOptions);

// Set appropriate content-type from the response
const contentType = response.headers.get("content-type") || "application/octet-stream";
res.setHeader("Content-Type", contentType);

// Optionally set caching headers if desired
// res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate");

// Stream the response directly to the client
response.body.pipe(res);
} catch (error) {
console.error("Error in proxy.js:", error);
res.status(500).send("Error fetching target URL.");
}
};