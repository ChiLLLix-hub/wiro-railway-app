import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
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

// Optional currency conversion for the displayed cost. Set CURRENCY_EXCHANGE
// (e.g. 4.5) in Railway's environment variables to multiply Wiro's USD
// totalcost into another currency - the multiplier itself can bake in a
// margin/profit on top of the real exchange rate if desired. Set
// CURRENCY_SYMBOL to change the displayed label (defaults to "RM").
const CURRENCY_EXCHANGE_RATE = Number(process.env.CURRENCY_EXCHANGE);
const CURRENCY_SYMBOL = process.env.CURRENCY_SYMBOL || 'RM';

// Only the final, converted cost is ever meant to reach the client - Wiro's
// raw USD `totalcost` and the exchange rate itself are intentionally kept
// out of the public response fields (finalCost/finalCostDisplay) so the
// frontend never has a way to surface Wiro's original price or the
// conversion rate used to arrive at the final number.
function formatTaskCost(task) {
  const amount = task?.totalcost == null || task.totalcost === ''
    ? null
    : String(task.totalcost);
  // Fall back to a 1:1 multiplier when no CURRENCY_EXCHANGE rate is
  // configured, so a "final cost" can always be computed/displayed without
  // ever needing to fall back to showing Wiro's raw amount directly.
  const rate = Number.isFinite(CURRENCY_EXCHANGE_RATE) && CURRENCY_EXCHANGE_RATE > 0
    ? CURRENCY_EXCHANGE_RATE
    : 1;

  let finalAmount = null;
  let finalDisplay = '—';

  if (amount != null) {
    const converted = Number(amount) * rate;
    if (Number.isFinite(converted)) {
      finalAmount = converted;
      finalDisplay = converted === 0
        ? `${CURRENCY_SYMBOL} 0 (no charge)`
        : `${CURRENCY_SYMBOL} ${converted.toFixed(2)}`;
    }
  }

  return {
    finalAmount,
    finalDisplay,
    currencySymbol: CURRENCY_SYMBOL
  };
}

// Optional margin multiplier for the *pre-generation* cost estimate shown to
// users before they click Generate. Set COST_MARGIN_MULTIPLIER (e.g. 1.2 for
// a 20% margin) in Railway's environment variables; it defaults to 1 (no
// margin) when unset or invalid. This is independent from CURRENCY_EXCHANGE,
// which only converts the *actual, already-charged* cost after a task runs.
const COST_MARGIN_MULTIPLIER = Number(process.env.COST_MARGIN_MULTIPLIER);

function getCostMarginMultiplier() {
  return Number.isFinite(COST_MARGIN_MULTIPLIER) && COST_MARGIN_MULTIPLIER > 0
    ? COST_MARGIN_MULTIPLIER
    : 1;
}

// Wiro's `dynamicprice` field (when present) is a JSON array of
// `{ price, priceMethod, inputs }` entries - one per parameter combination
// (e.g. per resolution/duration). Without knowing the user's exact selected
// parameters we can't pick the precise entry, so use the lowest listed price
// as a conservative "starting from" baseline estimate.
function parseDynamicPriceBaseline(dynamicprice) {
  if (!dynamicprice) return null;
  try {
    const parsed = typeof dynamicprice === 'string' ? JSON.parse(dynamicprice) : dynamicprice;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const prices = parsed.map(entry => Number(entry.price)).filter(Number.isFinite);
    return prices.length ? Math.min(...prices) : null;
  } catch {
    return null;
  }
}

// Best-effort baseline USD estimate for a model, straight from Wiro's own
// /Tool/List /Tool/Detail pricing signals (dynamicprice > approximatelycost
// > cps), before any margin or currency conversion is applied.
function estimateBaseCostUsd(tool) {
  if (!tool) return null;

  const dynamicBaseline = parseDynamicPriceBaseline(tool.dynamicprice);
  if (dynamicBaseline != null && dynamicBaseline > 0) return dynamicBaseline;

  const approx = Number(tool.approximatelycost);
  if (Number.isFinite(approx) && approx > 0) return approx;

  const cps = Number(tool.cps);
  if (Number.isFinite(cps) && cps > 0) return cps;

  return null;
}

// Wiro's raw USD pricing fields are intentionally never sent to the
// frontend as-is (same principle as formatTaskCost() below) - only this
// margin-adjusted, currency-converted estimate is, so the operator's margin
// and Wiro's original rate can't be reverse-engineered by the client.
function formatEstimatedCost(tool) {
  const baseUsd = estimateBaseCostUsd(tool);

  if (baseUsd == null) {
    return { estimatedAmount: null, estimatedDisplay: 'Not available', currencySymbol: CURRENCY_SYMBOL };
  }

  const rate = Number.isFinite(CURRENCY_EXCHANGE_RATE) && CURRENCY_EXCHANGE_RATE > 0
    ? CURRENCY_EXCHANGE_RATE
    : 1;
  const converted = baseUsd * getCostMarginMultiplier() * rate;

  return {
    estimatedAmount: Number.isFinite(converted) ? converted : null,
    estimatedDisplay: Number.isFinite(converted) ? `~${CURRENCY_SYMBOL} ${converted.toFixed(2)}` : 'Not available',
    currencySymbol: CURRENCY_SYMBOL
  };
}

function normalizeTaskOutputs(outputs = []) {
  return outputs
    .filter(output => output && output.url)
    .map((output, index) => ({
      id: `${output.name || 'output'}-${index + 1}`,
      name: output.name || `Output ${index + 1}`,
      url: output.url,
      contentType: output.contenttype || 'application/octet-stream',
      size: output.size || null
    }));
}

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

  // Wiro's own /Tool/List `sort` values (see wiro-mcp's search-models.js
  // zod enum). Anything else falls back to 'relevance' rather than being
  // forwarded as-is, since an invalid value causes Wiro to error out.
  const ALLOWED_SORTS = ['relevance', 'time', 'ratedusercount', 'commentcount', 'averagepoint'];

  try {
    const { search, categories, slugowner, sort, start, limit } = req.query;
    const requestedSort = String(sort || '').trim();

    // Cap the page size so a client-supplied `limit` can't force us to pull
    // (and re-serve) the entire 500+ model catalog in one response - the
    // whole point of paging is a small, fast payload per page.
    const requestedLimit = limit ? Number(limit) : 20;
    const safeLimit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 20;
    const requestedStart = start ? Number(start) : 0;
    const safeStart = Number.isFinite(requestedStart) && requestedStart >= 0 ? requestedStart : 0;

    const result = await client.searchModels({
      search: search || undefined,
      categories: categories ? String(categories).split(',') : undefined,
      slugowner: slugowner || undefined,
      sort: ALLOWED_SORTS.includes(requestedSort) ? requestedSort : 'relevance',
      start: safeStart,
      limit: safeLimit
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
      categories: (model.categories || []).filter(c => c !== 'tool'),
      // Cover thumbnail + example output URLs, straight from Wiro's
      // /Tool/List response - lets the frontend render a real preview
      // image per model instead of a text-only card.
      image: model.image || null,
      samples: Array.isArray(model.samples) ? model.samples : [],
      tags: Array.isArray(model.tags) ? model.tags : [],
      // Raw pricing signals from Wiro so the frontend can show a cost hint
      // without hardcoding per-model prices.
      dynamicprice: model.dynamicprice || null,
      cps: model.cps || null,
      approximatelycost: model.approximatelycost || null
    }));

    return res.json({
      data: models,
      total: Number(result.total) || models.length,
      start: safeStart,
      limit: safeLimit
    });
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

// Several Wiro model parameters are reported with overly-permissive
// min/max/default values (or none at all), which lets the UI submit
// negative/decimal values that the underlying (mostly video) models don't
// actually support, or leaves important quality knobs unset. Normalize the
// handful of well-known offenders here so every model gets sane, whole-number
// constraints and sensible defaults regardless of what Wiro itself reports.
const DURATION_SECONDS_MIN = 5;
const DURATION_SECONDS_MAX = 30;
const DEFAULT_INFERENCE_STEPS = 10;
const DEFAULT_GUIDANCE_SCALE = 2;
// "Shift" (a.k.a. flow-matching/noise schedule shift) controls how a
// diffusion/video model's scheduler spaces its timesteps - left unset it
// defaults to whatever Wiro's own form happens to report (often nothing at
// all), so give it the same commonly-used baseline as other quality knobs.
const DEFAULT_SHIFT = 5;

function normalizeParameterItem(item) {
  const text = `${item.id || ''} ${item.label || ''}`.toLowerCase();
  const type = (item.type || '').toLowerCase();
  const isNumeric = type === 'number' || type === 'integer' || type === 'float';

  if (!isNumeric) return item;

  const isDurationField = /duration/.test(text) || /\bsecond/.test(text);
  const isInferenceStepsField = /step/.test(text) && (/infer/.test(text) || /\bsteps?\b/.test(text));
  const isGuidanceScaleField = /guidance/.test(text);
  const isShiftField = /\bshift\b/.test(text);

  const normalized = { ...item };

  if (isDurationField) {
    // Video length must be a whole number of seconds between 5 and 30 -
    // no negative values and no fractional seconds.
    normalized.type = 'integer';
    normalized.min = DURATION_SECONDS_MIN;
    normalized.max = DURATION_SECONDS_MAX;
    normalized.step = 1;
    const currentDefault = Number(normalized.default);
    if (!Number.isFinite(currentDefault) || currentDefault < DURATION_SECONDS_MIN || currentDefault > DURATION_SECONDS_MAX) {
      normalized.default = DURATION_SECONDS_MIN;
    } else {
      normalized.default = Math.round(currentDefault);
    }
  } else if (isInferenceStepsField) {
    normalized.default = DEFAULT_INFERENCE_STEPS;
  } else if (isGuidanceScaleField) {
    normalized.default = DEFAULT_GUIDANCE_SCALE;
  } else if (isShiftField) {
    normalized.default = DEFAULT_SHIFT;
  }

  return normalized;
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
      items: (group.items || []).map(item => normalizeParameterItem({
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
      estimatedCost: formatEstimatedCost(tool)
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
async function handleReferenceUpload(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded. Attach it as multipart/form-data field "file".' });
    }

    const formData = new FormData();
    const blob = new Blob([req.file.buffer], { type: req.file.mimetype || 'application/octet-stream' });
    // Wiro may reject a second upload under the same filename with
    // "filesystem-already-exist" and no reusable URL. Give each upload a
    // unique name while keeping the extension for media type detection.
    const originalName = req.file.originalname || 'upload';
    const extension = extname(originalName);
    const uploadName = `${randomUUID()}${/^\.[a-z0-9]{1,16}$/i.test(extension) ? extension : ''}`;
    formData.append('file', blob, uploadName);

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

    // Some Wiro responses report a conflict but still include a reusable
    // file URL. Only fail when no URL was returned.
    const file = payload.list?.[0];
    if (!file?.url) {
      const message = payload.errors?.map(e => e.message).join(', ') || 'Upload failed.';
      return res.status(502).json({ error: message });
    }

    return res.json({ url: file.url, name: originalName, contentType: file.contenttype, size: file.size });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
}

app.post('/upload', upload.single('file'), handleReferenceUpload);
app.post('/api/upload', upload.single('file'), handleReferenceUpload);

// Dynamic Model Execution Endpoint
app.post('/generate', async (req, res) => {
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

    const run = await client.runModel(selectedModel, options);

    if (!run || !run.result) {
      return res.status(500).json({ error: run?.errors || 'Model execution failed' });
    }

    // Respond as soon as Wiro hands back a task/job ID - do NOT block this
    // request on client.waitForTask(). Some generations (video, long-running
    // models, etc.) take far longer than the browser/proxy's HTTP timeout,
    // so waiting here meant the connection dropped before a response was
    // ever sent even though the task itself kept running (and often
    // succeeding) server-side on Wiro - leaving the user with no taskId to
    // look the result up with later. The frontend now polls GET
    // /task/:taskId to learn when the task finishes.
    return res.json({
      success: true,
      pending: true,
      status: 'queued',
      taskId: run.taskid,
      socketaccesstoken: run.socketaccesstoken
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Wiro's debugoutput is a multi-line log, e.g.:
//   "Request started.\nTask failed\nOutputImageSensitiveContentDetected.PolicyViolation, message: ..."
// The last non-empty line is almost always the actual error/reason, so pull
// that out for a concise, human-readable message; fall back to the whole
// debugoutput (or a generic message) if it's missing/empty.
function extractFailureReason(task) {
  const debugOutput = task && typeof task.debugoutput === 'string' ? task.debugoutput.trim() : '';
  if (!debugOutput) return 'Task failed to generate output.';

  const lines = debugOutput.split('\n').map(l => l.trim()).filter(Boolean);
  const lastLine = lines[lines.length - 1];
  return lastLine || debugOutput;
}

// A task is only "finished" once Wiro reports a non-empty `pexit` code -
// while a task is still queued/running, `pexit` is empty/undefined and
// `debugoutput` won't yet contain a meaningful failure reason.
function isTaskPending(task) {
  return !task || task.pexit == null || task.pexit === '';
}

// Retrieve a previously submitted task by its ID, so users can look up a
// finished (or still-running/failed) generation using only the job/task
// number they saved earlier - without needing to keep the browser tab open
// or re-submit the same prompt.
app.get('/task/:taskId', async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

  try {
    const taskId = String(req.params.taskId || '').trim();
    if (!taskId) {
      return res.status(400).json({ success: false, error: 'A task ID is required.' });
    }

    const detail = await client.getTask({ taskid: taskId });

    if (!detail.result) {
      const message = detail.errors?.map(e => e.message).join(', ') || 'Failed to look up task.';
      return res.status(502).json({ success: false, error: message });
    }

    const task = (detail.tasklist || [])[0];
    if (!task) {
      return res.status(404).json({ success: false, error: `No task found for ID "${taskId}".` });
    }

    if (isTaskPending(task)) {
      return res.json({
        success: false,
        pending: true,
        status: task.status,
        taskId: task.id,
        error: 'This task is still queued or running. Please check again shortly.'
      });
    }

    if (task.pexit === '0') {
      const outputs = task.outputs || [];
      const downloadableOutputs = normalizeTaskOutputs(outputs);
      const mediaOutput = downloadableOutputs[0] || null;
      const taskCost = formatTaskCost(task);

      return res.json({
        success: true,
        output: task.debugoutput,
        mediaUrl: mediaOutput ? mediaOutput.url : null,
        taskId: task.id,
        finalCost: taskCost.finalAmount,
        finalCostDisplay: taskCost.finalDisplay,
        currencySymbol: taskCost.currencySymbol,
        downloads: downloadableOutputs,
        outputs,
        task: task
      });
    }

    const failureReason = extractFailureReason(task);
    return res.status(200).json({
      success: false,
      error: failureReason,
      debugOutput: task.debugoutput,
      taskId: task.id,
      task: task
    });
  } catch (error) {
    if (error instanceof WiroApiError) {
      return res.status(error.status).json({ success: false, error: error.message });
    }
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
