// server.js
const express = require('express');
const bodyParser = require('body-parser');
const { google } = require('googleapis');
const multer = require('multer');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.post('/webhook', async (req, res) => {
  res.send('Webhook received!');
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});