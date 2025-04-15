// This proxy function forwards the request to the target URL,
// and modifies the "User-Agent" header.
module.exports = async (req, res) => {
    try {
      // Get the 'url' query parameter.
      const targetUrl = req.query.url;
      if (!targetUrl) {
        res.status(400).send("Missing URL parameter.");
        return;
      }
      // Perform the fetch request with modified User-Agent header.
      const response = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N)'
        }
      });
      // Get response headers and body.
      const contentType = response.headers.get("content-type");
      res.setHeader("content-type", contentType);
      // You could also forward additional headers if needed.
      const body = await response.arrayBuffer();
      res.status(response.status).send(Buffer.from(body));
    } catch (err) {
      console.error(err);
      res.status(500).send("Error occurred in proxy.");
    }
  };