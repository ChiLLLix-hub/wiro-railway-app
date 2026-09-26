import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { WiroClient, WiroApiError } from '@wiro-ai/wiro-mcp/client';

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

// In-memory storage keeps uploaded reference media (images/video/audio) in
// RAM only long enough to relay it to Wiro's File/Upload endpoint - nothing
// is written to disk on the Railway instance.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB per file, matches typical Wiro reference-media limits
});

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

// Resolve a model's full detail/parameter schema from Wiro.
//
// Some models returned by /Tool/List (search) only match /Tool/Detail when
// queried with their *raw* `slugowner`/`slugproject` values - the
// `cleanslugowner`/`cleanslugproject` fields (used to build the human/URL
// friendly "owner/project" slug shown in the UI) can occasionally differ in
// casing or punctuation from the raw slug the Detail endpoint expects. That
// mismatch previously surfaced to users as a hard 404 ("Model ... was not
// found") even though the model genuinely exists, with the frontend falling
// back to the generic "Could not load extra parameters for this model" copy.
// To make schema lookups resilient we first try the slug as given, and if
// Wiro reports no match, fall back to searching for the model and retrying
// Detail with its raw slug fields before giving up.
async function resolveModelDetail(modelSlug) {
  const tool = await lookupToolDetail(modelSlug);
  if (tool) return tool;

  const [ownerPart, ...rest] = modelSlug.split('/');
  const projectPart = rest.join('/');
  if (!ownerPart || !projectPart) return null;

  const searchResult = await client.searchModels({ search: projectPart, limit: 50 });
  if (!searchResult.result) return null;

  const candidates = searchResult.tool || [];
  const match = candidates.find(candidate => (
    (candidate.cleanslugowner || '').toLowerCase() === ownerPart.toLowerCase()
    && (candidate.cleanslugproject || '').toLowerCase() === projectPart.toLowerCase()
  ));

  if (!match || !match.slugowner || !match.slugproject) return null;

  const rawSlug = `${match.slugowner}/${match.slugproject}`;
  if (rawSlug === modelSlug) return null; // Already tried, still not found.

  return lookupToolDetail(rawSlug);
}

async function lookupToolDetail(modelSlug) {
  const result = await client.getModelSchema(modelSlug);

  if (!result.result) {
    const message = result.errors?.map(e => e.message).join(', ') || 'Failed to fetch model schema.';
    throw Object.assign(new Error(message), { status: 502 });
  }

  return (result.tool || [])[0] || null;
}

const PRICE_METHOD_LABELS = {
  'cp-outputPictureCount': 'per image',
  'cp-outputVideoLength': 'per video second',
  'cp-realtimeturn': 'per turn',
  'cp-readoutput': 'model-reported'
};

// Wiro exposes a model's estimated cost via a handful of fields on the
// /Tool/List and /Tool/Detail responses (`dynamicprice`, `approximatelycost`,
// `cps`) - there is no separate "estimate before running" endpoint, so we
// surface these fields (the same ones Wiro's own MCP tool formats for
// display) to answer "can Wiro show an estimated cost before generating?".
function estimateModelPricing(tool) {
  if (!tool) return null;

  if (tool.dynamicprice) {
    try {
      const parsed = typeof tool.dynamicprice === 'string' ? JSON.parse(tool.dynamicprice) : tool.dynamicprice;
      if (Array.isArray(parsed) && parsed.length > 0) {
        const prices = parsed.map(p => Number(p.price)).filter(n => Number.isFinite(n));
        const label = PRICE_METHOD_LABELS[parsed[0].priceMethod] || parsed[0].priceMethod || 'run';
        if (prices.length === 1) {
          return { estimatedCostUsd: prices[0], label: `$${prices[0]} / ${label}` };
        }
        if (prices.length > 1) {
          const min = Math.min(...prices);
          const max = Math.max(...prices);
          return { estimatedCostUsd: null, label: `$${min} – $${max} / ${label} (varies by parameters)` };
        }
      }
    } catch {
      // Fall through to the simpler approximatelycost/cps fields below.
    }
  }

  const approx = parseFloat(tool.approximatelycost ?? '0');
  if (approx > 0) {
    return { estimatedCostUsd: approx, label: `~$${approx} per run (estimated)` };
  }

  const cps = parseFloat(tool.cps ?? '0');
  if (cps > 0) {
    return { estimatedCostUsd: null, label: `$${cps} per second (varies by duration)` };
  }

  return null;
}

// Model Schema Endpoint
// Different models expect different (often required) parameters -
// e.g. bytedance/seedream-v4 requires `size`, `maxImages` and `watermark`,
// while alibaba/wan-2-1-video expects video-specific fields. Instead of
// guessing/hardcoding fields per model, expose the model's real parameter
// schema (from Wiro's `/Tool/Detail` endpoint) so the frontend can render
// the correct inputs and mark required fields for the user.
app.get('/models/schema', async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Surrogate-Control', 'no-store');

  try {
    const { model } = req.query;

    if (!model) {
      return res.status(400).json({ error: 'Query parameter "model" is required (e.g. ?model=owner/project).' });
    }

    // Trim stray whitespace/slashes - a trailing slash (e.g. from a
    // copy-pasted URL) turns "owner/project" into "owner/project/" which
    // getModelSchema() would otherwise happily send to /Tool/Detail as
    // slugproject="project/", causing Wiro to report the model as not found.
    let requestedModel = String(model).trim();
    while (requestedModel.startsWith('/')) requestedModel = requestedModel.slice(1);
    while (requestedModel.endsWith('/')) requestedModel = requestedModel.slice(0, -1);

    const tool = await resolveModelDetail(requestedModel);

    if (!tool) {
      return res.status(404).json({ error: `Model "${requestedModel}" was not found.` });
    }

    const parameters = (tool.parameters || []).map(group => ({
      title: group.title,
      items: (group.items || []).map(item => ({
        id: item.id,
        type: item.type,
        label: item.label,
        description: item.description,
        default: item.default,
        required: !!item.required,
        placeholder: item.placeholder,
        note: item.note,
        options: item.options,
        min: item.min,
        max: item.max,
        step: item.step,
        advanced: !!item.advanced
      }))
    }));

    return res.json({
      slug: requestedModel,
      title: tool.title,
      description: tool.seodescription || tool.description || '',
      parameters,
      // Estimated cost before running generation (see estimateModelPricing).
      // `null` when Wiro doesn't expose enough pricing info to estimate.
      pricing: estimateModelPricing(tool)
    });
  } catch (error) {
    if (error instanceof WiroApiError) {
      // Surface Wiro's real upstream status/message (e.g. 401 for bad
      // credentials, 404 for a genuinely unknown model) instead of masking
      // every failure behind a generic 500/404, which made this class of
      // issue hard to diagnose from the frontend's fallback message alone.
      return res.status(error.status).json({ error: error.message });
    }
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Reference Media Upload Endpoint
//
// Model parameters of type `fileinput`/`multifileinput`/`combinefileinput`
// (e.g. `reference_images`, `first_frame_image`) expect a Wiro-hosted URL,
// not a raw browser File - the frontend can't send an in-browser file
// straight to /generate as JSON. This endpoint accepts the actual file the
// user picked (multipart/form-data), relays it to Wiro's `/File/Upload`
// endpoint using our server-side credentials, and returns the resulting
// hosted URL so the frontend can attach it to the run parameters.
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded. Attach it as multipart/form-data field "file".' });
    }

    const formData = new FormData();
    const blob = new Blob([req.file.buffer], { type: req.file.mimetype || 'application/octet-stream' });
    formData.append('file', blob, req.file.originalname || 'upload');

    const uploadUrl = `${client.baseUrl}/File/Upload`;
    // Reuse the SDK's own HMAC auth headers so this endpoint stays in sync
    // with however WiroClient authenticates every other request.
    const headers = client.getAuthHeaders(new URL(uploadUrl).pathname);
    delete headers['Content-Type']; // Let fetch set the multipart boundary itself.

    const response = await fetch(uploadUrl, { method: 'POST', headers, body: formData });
    const text = await response.text();

    if (!response.ok) {
      return res.status(502).json({ error: `Wiro upload failed (${response.status}): ${text}` });
    }

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return res.status(502).json({ error: 'Invalid response from Wiro upload service.' });
    }

    if (!payload.result || !payload.list?.length) {
      const message = payload.errors?.map(e => e.message).join(', ') || 'Upload failed.';
      return res.status(502).json({ error: message });
    }

    const file = payload.list[0];
    if (!file.url) {
      return res.status(502).json({ error: 'Upload succeeded but no reusable file URL was returned.' });
    }

    return res.json({ url: file.url, name: file.name, contentType: file.contenttype, size: file.size });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Dynamic Model Execution Endpoint
//
// Generation on Wiro can take anywhere from a few seconds to a few minutes,
// and the frontend previously had no visibility into what was happening
// while it waited for a single, synchronous JSON response. This endpoint now
// streams progress as Server-Sent Events so the frontend can:
//   1. Show the task number as soon as the task is created ("started").
//   2. Show live status updates while the task is running ("progress").
//   3. Show the task number/media and the actual cost Wiro charged for the
//      run ("done") - `task.totalcost` is exactly the field Wiro's own
//      "Get Task Price" tool reports (billed only for successful tasks).
app.post('/generate', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Stop polling Wiro if the client navigates away/aborts mid-generation.
  const abortController = new AbortController();
  req.on('close', () => abortController.abort());

  try {
    const { model, prompt, ...rest } = req.body || {};

    const selectedModel = model || 'alibaba/wan-2-7-image';

    const options = {
      prompt: prompt || 'A cinematic studio render...'
    };

    // Forward every other field the client sends as-is. Models each define
    // their own required/optional parameters (size, maxImages, watermark,
    // duration, aspect_ratio, etc.) via their schema - see GET
    // /models/schema - so rather than hardcoding a fixed set of fields here
    // we pass through whatever the (schema-driven) frontend form collected.
    for (const [key, value] of Object.entries(rest)) {
      if (value === undefined || value === null || value === '') continue;
      options[key] = value;
    }

    const run = await client.runModel(selectedModel, options, abortController.signal);

    if (!run || !run.result) {
      const message = run?.errors?.map(e => e.message).join(', ') || 'Model execution failed';
      send('error', { success: false, error: message });
      return res.end();
    }

    // Let the frontend display the task number the moment it exists, well
    // before generation finishes.
    send('started', { taskId: run.taskid, taskToken: run.socketaccesstoken });

    let lastStatus = null;
    const result = await client.waitForTask(run.socketaccesstoken, undefined, {
      signal: abortController.signal,
      onPoll: (currentTask) => {
        if (currentTask.status !== lastStatus) {
          lastStatus = currentTask.status;
          send('progress', {
            taskId: currentTask.id,
            status: currentTask.status,
            elapsedSeconds: currentTask.elapsedseconds || null
          });
        }
      }
    });

    const task = result.tasklist[0];

    if (task && task.pexit === '0') {
      // `task.outputs` is Wiro's structured output list (each item has a
      // reliable `.url` + `.contenttype`), unlike `task.debugoutput` which
      // is a free-form debug string that doesn't always contain a directly
      // usable media URL. Surface the first output with a URL explicitly so
      // the frontend doesn't have to guess-parse debugoutput.
      const outputs = task.outputs || [];
      const mediaOutput = outputs.find(o => o && o.url) || null;

      send('done', {
        success: true,
        taskId: task.id,
        output: task.debugoutput,
        mediaUrl: mediaOutput ? mediaOutput.url : null,
        outputs,
        // Wiro only bills successful tasks - `totalcost` is unset/"0" for
        // tasks that failed, which is why this is only read here.
        costUsd: task.totalcost ? Number(task.totalcost) : 0,
        task
      });
    } else {
      send('error', { success: false, taskId: task?.id, error: 'Task failed to generate output.' });
    }
  } catch (error) {
    if (!abortController.signal.aborted) {
      send('error', { success: false, error: error.message });
    }
  } finally {
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
