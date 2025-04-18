// server.js
const express = require('express');
const path = require('path');
const app = express();
const PORT = 3001;

// Serve static files from the "public" folder.
app.use(express.static(path.join(__dirname, 'public')));

// Catch-all route using '/'
app.get('/', (req, res) => {
res.sendFile(path.join(__dirname, 'public', 'camviewer_v2.html'));
});

app.listen(PORT, () => {
    console.log("Server running. Access the HTML at http://localhost:" + PORT);
});