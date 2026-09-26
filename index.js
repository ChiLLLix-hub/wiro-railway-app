import express from 'express';
import cors from 'cors';
import { WiroClient } from '@wiro-ai/wiro-mcp/client';

const app = express();
const PORT = process.env.PORT || 3000;

// 1. Enable CORS for your frontend domain
app.use(cors({
  origin: ['https://agromar.com.my', 'http://localhost:3000'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// 2. Middleware to parse JSON payloads
app.use(express.json());

// Initialize Wiro Client
const client = new WiroClient(
  process.env.WIRO_API_KEY,
  process.env.WIRO_API_SECRET
);

// 3. Define your generation endpoint (POST allows receiving custom prompts from frontend)
app.post('/generate', async (req, res) => {
  try {
    const { prompt } = req.body;

    const run = await client.runModel('alibaba/wan-2-7-image', {
      prompt: prompt || 'A cinematic image set following the woman…',
      size: '1K',
      samples: 1
    });

    if (!run || !run.result) {
      return res.status(500).json({ error: run?.errors || 'Model execution failed' });
    }

    // Wait for the task to complete
    const result = await client.waitForTask(run.socketaccesstoken);
    const task = result.tasklist[0];

    if (task && task.pexit === '0') {
      // Send a clean JSON response back to your web app
      return res.json({
        success: true,
        output: task.debugoutput,
        task: task
      });
    } else {
      return res.status(500).json({ success: false, error: 'Task failed to generate.' });
    }
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// 4. Start the server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
