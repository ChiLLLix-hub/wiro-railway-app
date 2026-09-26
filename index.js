import express from 'express';
import cors from 'cors';
import { WiroClient } from '@wiro-ai/wiro-mcp/client';

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for your cPanel domain
app.use(cors({
  origin: ['https://agromar.com.my', 'http://localhost:3000'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date() });
});

// FIXED: Dynamic models list endpoint with correct Wiro API authentication headers
// Dynamic models list endpoint
app.get('/models', async (req, res) => {
  try {
    const response = await fetch('https://api.wiro.ai/v1/Models', {
      headers: {
        'x-api-key': process.env.WIRO_API_KEY,
        'x-api-secret': process.env.WIRO_API_SECRET
      }
    });

    const data = await response.json();

    // Handle Wiro's standard wrapper response { result: true, data: [...] }
    if (data.result && Array.isArray(data.data)) {
      return res.json(data.data);
    } else if (Array.isArray(data)) {
      return res.json(data);
    } else {
      return res.json(data.data || []);
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const client = new WiroClient(
  process.env.WIRO_API_KEY,
  process.env.WIRO_API_SECRET
);

// Dynamic Model Execution Endpoint
app.post('/generate', async (req, res) => {
  try {
    const { model, prompt, size, duration, aspect_ratio } = req.body;

    const selectedModel = model || 'alibaba/wan-2-7-image';

    const options = {
      prompt: prompt || 'A cinematic studio render...'
    };

    if (size) options.size = size;
    if (duration) options.duration = duration;
    if (aspect_ratio) options.aspect_ratio = aspect_ratio;

    const run = await client.runModel(selectedModel, options);

    if (!run || !run.result) {
      return res.status(500).json({ error: run?.errors || 'Model execution failed' });
    }

    const result = await client.waitForTask(run.socketaccesstoken);
    const task = result.tasklist[0];

    if (task && task.pexit === '0') {
      return res.json({
        success: true,
        output: task.debugoutput,
        task: task
      });
    } else {
      return res.status(500).json({ success: false, error: 'Task failed to generate output.' });
    }
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
