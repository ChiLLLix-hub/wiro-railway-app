import express from 'express';
import { WiroClient } from '@wiro-ai/wiro-mcp/client';

const app = express();

// Railway automatically provides a PORT environment variable.
// We use 3000 as a fallback for local testing.
const PORT = process.env.PORT || 3000;

// Initialize the Wiro Client using Environment Variables
// (We will set these securely in Railway later)
const client = new WiroClient(
  process.env.WIRO_API_KEY,
  process.env.WIRO_API_SECRET
);

app.get('/generate', async (req, res) => {
  try {
    // 1. Run the AI Model (e.g., generating a simple text response)
    
    const run = await client.runModel('alibaba/wan-2-7-image', {
    prompt: 'A cinematic image set following the woman…',
    size: '1K',
    samples: 1
});

    if (!run.result) {
      return res.status(500).json({ error: run.errors });
    }

    // 2. Wait for the task to finish processing
    const result = await client.waitForTask(run.socketaccesstoken);
    const task = result.tasklist[0];

    // 3. Send the output back to the browser
    if (task.pexit === '0') {
      res.send(`<h1>AI Says:</h1> <p>${task.debugoutput}</p>`);
    } else {
      res.send('Task failed to generate.');
    }
  } catch (error) {
    res.status(500).send(error.message);
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors({
  origin: ['https://agromar.com.my', 'http://localhost:3000'], // Allow your frontend origin
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
