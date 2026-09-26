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

const client = new WiroClient(
  process.env.WIRO_API_KEY,
  process.env.WIRO_API_SECRET
);

// Dynamic Model Execution Endpoint
app.post('/generate', async (req, res) => {
  try {
    const { model, prompt, size, duration, aspect_ratio } = req.body;

    // Default to Wan 2.7 Image if no model is provided
    const selectedModel = model || 'alibaba/wan-2-7-image';

    // Construct options payload dynamically
    const options = {
      prompt: prompt || 'A cinematic studio render...'
    };

    if (size) options.size = size;
    if (duration) options.duration = duration;
    if (aspect_ratio) options.aspect_ratio = aspect_ratio;

    // Run whatever model was requested by the client
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
