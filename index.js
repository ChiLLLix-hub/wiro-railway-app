import express from 'express';
import cors from 'cors';
import { WiroClient } from '@wiro-ai/wiro-mcp/client';

const app = express();
const PORT = process.env.PORT || 3000;

// Disable ETag-based conditional caching (304 Not Modified) globally.
// Express enables weak ETags by default, which caused GET /models to be
// answered with an empty 304 response on repeat requests, leaving the
// frontend dropdown stuck without any models.
app.disable('etag');

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

// Dynamic models list endpoint
// Uses the Wiro SDK's searchModels() helper, which correctly calls the
// authenticated `/Tool/List` endpoint (POST + HMAC signature headers)
// instead of the non-existent, unauthenticated `GET /v1/Models` route.
app.get('/models', async (req, res) => {
  // Prevent the browser/proxy from serving a cached or conditional (304 Not
  // Modified, empty-body) response, which previously left the frontend
  // dropdown stuck on its fallback hardcoded options.
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Surrogate-Control', 'no-store');

  try {
    const { search, categories, slugowner, sort, start, limit } = req.query;

    const result = await client.searchModels({
      search: search || undefined,
      categories: categories ? String(categories).split(',') : undefined,
      slugowner: slugowner || undefined,
      sort: sort || 'relevance',
      start: start ? Number(start) : 0,
      limit: limit ? Number(limit) : 100
    });

    if (!result.result) {
      const message = result.errors?.map(e => e.message).join(', ') || 'Failed to fetch models.';
      return res.status(502).json({ error: message });
    }

    const models = (result.tool || []).map(model => ({
      slug: `${model.cleanslugowner}/${model.cleanslugproject}`,
      owner: model.cleanslugowner,
      project: model.cleanslugproject,
      name: model.title || `${model.cleanslugowner}/${model.cleanslugproject}`,
      title: model.title,
      description: model.seodescription || model.description || '',
      categories: (model.categories || []).filter(c => c !== 'tool')
    }));

    return res.json({ data: models, total: Number(result.total) || models.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

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
