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

// Wiro's `dynamicprice` field (when present) is a JSON array of
// `{ price, priceMethod, inputs }` entries - one per parameter combination
// (e.g. per resolution/duration). When the caller's current parameter
// selections are unknown (or match no entry) we fall back to the lowest
// listed price as a conservative "starting from" baseline estimate.
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

// Normalizes a param key for fuzzy matching against a `dynamicprice` entry's
// `inputs` keys (Wiro's naming doesn't always line up 1:1 with the schema's
// field ids, e.g. "resolution" vs "size").
function normalizePriceKey(key) {
  return String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Builds a normalized-key -> value lookup from the user's current form
// values, also synthesizing a combined "WIDTHxHEIGHT" value under
// `size`/`resolution` when separate `width`/`height` params are present, so
// dynamicprice entries keyed by a single resolution string can still match.
function buildParamLookup(params) {
  const lookup = {};
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value == null || value === '') return;
    lookup[normalizePriceKey(key)] = value;
  });

  const width = params?.width ?? params?.Width;
  const height = params?.height ?? params?.Height;
  if (width != null && width !== '' && height != null && height !== '') {
    const size = `${width}x${height}`;
    if (lookup.size == null) lookup.size = size;
    if (lookup.resolution == null) lookup.resolution = size;
  }

  return lookup;
}

function findParamValueByKey(lookup, key) {
  const normalizedKey = normalizePriceKey(key);
  if (lookup[normalizedKey] != null) return lookup[normalizedKey];
  const fuzzyMatch = Object.keys(lookup).find(k => k.includes(normalizedKey) || normalizedKey.includes(k));
  return fuzzyMatch ? lookup[fuzzyMatch] : undefined;
}

// Normalizes a dynamicprice entry's `inputs` *value* (e.g. a resolution like
// "1024x1024", "1024X1024", "1024 x 1024" or "1024*1024") for comparison
// against the user's selected param value. Different Wiro tools format the
// same resolution/aspect-ratio/duration value with inconsistent casing,
// whitespace or separators (x/X/*/by) - comparing the raw strings as-is
// caused every dynamicprice entry to silently fail to match whenever the
// selected option's exact string didn't line up byte-for-byte, so the
// estimate always fell back to the static "starting from" baseline instead
// of updating when the user changed resolution/duration/etc.
function normalizePriceValue(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[x×*]/g, 'x')
    .replace(/\bby\b/g, 'x');
}

// Several image models let the user request more than one image per run
// (e.g. SeeDream V4's `maxImages`), and Wiro bills per output on those
// models - so a per-run price (dynamicprice's base entry, a flat
// `approximatelycost`, or an undetected `cps`-with-no-duration case) needs
// multiplying by the requested count to stay accurate. Match the user's
// current params against these common "how many outputs" field names
// (exact normalized match only - deliberately not fuzzy, since a bare "n"
// or "count" is too ambiguous to safely assume it means image count).
const IMAGE_COUNT_PARAM_KEYS = [
  'maximages', 'numimages', 'numberofimages', 'imagescount', 'imagecount',
  'countimages', 'batchsize', 'numoutputs', 'outputcount', 'numberofoutputs',
  'outputsnumber', 'imagesnumber', 'numimagestogenerate', 'imagestogenerate'
];

function findImageCountValue(lookup) {
  for (const key of IMAGE_COUNT_PARAM_KEYS) {
    if (lookup[key] == null) continue;
    const count = Number(lookup[key]);
    if (Number.isFinite(count) && count > 0) return { key, count };
  }
  return null;
}

// Wiro's video/image pricing is rarely a single flat number - `dynamicprice`
// lists one price per parameter combination (e.g. per resolution/duration
// tier), and some entries use an `"QUANTITY:<n>"` marker meaning "multiply
// this per-unit price by the matching numeric param" (e.g. price-per-second
// times the selected duration, or price-per-output times the requested
// image count). Match the current form values against each entry and return
// the cost of the best (most specific) match - along with which input keys
// were already consumed as quantity multipliers, so the caller can avoid
// double-multiplying by image count below - so the estimate actually
// follows duration/resolution/image-count/etc. instead of always showing
// the same "starting from" number.
function matchDynamicPriceCostUsd(dynamicprice, params) {
  if (!dynamicprice) return null;

  let parsed;
  try {
    parsed = typeof dynamicprice === 'string' ? JSON.parse(dynamicprice) : dynamicprice;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;

  const lookup = buildParamLookup(params);
  let best = null;

  for (const entry of parsed) {
    const price = Number(entry?.price);
    if (!Number.isFinite(price)) continue;

    const inputs = entry.inputs || {};
    const keys = Object.keys(inputs);

    if (keys.length === 0) {
      if (!best) best = { score: 0, cost: price, quantityKeys: new Set() };
      continue;
    }

    let matched = true;
    let multiplier = 1;
    let score = 0;
    const quantityKeys = new Set();

    for (const key of keys) {
      const rawValue = inputs[key];
      const paramValue = findParamValueByKey(lookup, key);

      if (typeof rawValue === 'string' && rawValue.toUpperCase().startsWith('QUANTITY:')) {
        const qty = Number(paramValue);
        if (!Number.isFinite(qty) || qty <= 0) { matched = false; break; }
        multiplier *= qty;
        quantityKeys.add(normalizePriceKey(key));
        score += 1;
      } else if (paramValue != null && normalizePriceValue(paramValue) === normalizePriceValue(rawValue)) {
        score += 2; // Exact matches are a stronger signal than quantity scaling.
      } else {
        matched = false;
        break;
      }
    }

    if (!matched) continue;

    const cost = price * multiplier;
    if (Number.isFinite(cost) && (!best || score > best.score)) {
      best = { score, cost, quantityKeys };
    }
  }

  return best ? { cost: best.cost, quantityKeys: best.quantityKeys } : null;
}

// Best-effort USD estimate for a model, straight from Wiro's own
// /Tool/List /Tool/Detail pricing signals, before any margin or currency
// conversion is applied. When `params` (the user's current form values) are
// supplied, prefers a cost computed from the actual dynamicprice/cps method
// (e.g. per-second * duration) over a static baseline, since real Wiro
// pricing is rarely flat - it follows duration, resolution, requested image
// count and similar parameters.
function estimateBaseCostUsd(tool, params) {
  if (!tool) return null;

  const lookup = buildParamLookup(params);
  const imageCount = findImageCountValue(lookup);

  // Applies the "how many outputs" multiplier to a per-run/per-output base
  // cost, unless `skipKey` (an input key dynamicprice already scaled by)
  // is the same field, which would otherwise double-count it.
  const withImageCount = (cost, skipKey) => {
    if (cost == null) return cost;
    if (!imageCount) return cost;
    if (skipKey && skipKey.has(imageCount.key)) return cost;
    return cost * imageCount.count;
  };

  const dynamicMatch = matchDynamicPriceCostUsd(tool.dynamicprice, params);
  if (dynamicMatch?.cost != null && dynamicMatch.cost > 0) {
    return withImageCount(dynamicMatch.cost, dynamicMatch.quantityKeys);
  }

  const dynamicBaseline = parseDynamicPriceBaseline(tool.dynamicprice);
  if (dynamicBaseline != null && dynamicBaseline > 0) return withImageCount(dynamicBaseline);

  const cps = Number(tool.cps);
  if (Number.isFinite(cps) && cps > 0) {
    const durationValue = findParamValueByKey(lookup, 'duration') ?? findParamValueByKey(lookup, 'seconds');
    const duration = Number(durationValue);
    // cps is a per-second rate - the real cost of a run scales with the
    // selected duration, so multiply rather than reporting the flat rate.
    if (Number.isFinite(duration) && duration > 0) return withImageCount(cps * duration);
  }

  const approx = Number(tool.approximatelycost);
  if (Number.isFinite(approx) && approx > 0) return withImageCount(approx);
  if (Number.isFinite(cps) && cps > 0) return withImageCount(cps);

  return null;
}

// Wiro's raw USD pricing fields are intentionally never sent to the
// frontend as-is (same principle as formatTaskCost() below) - only this
// currency-converted estimate is, using the same CURRENCY_EXCHANGE rate (and
// CURRENCY_SYMBOL) already used to convert the actual post-run cost, so any
// margin baked into that rate applies consistently to both. `params` (when
// provided) are the user's current form values, used to compute a
// dynamic/parameter-aware estimate instead of a static baseline.
function formatEstimatedCost(tool, params) {
  const baseUsd = estimateBaseCostUsd(tool, params);

  if (baseUsd == null) {
    return { estimatedAmount: null, estimatedDisplay: 'Not available', currencySymbol: CURRENCY_SYMBOL };
  }

  const rate = Number.isFinite(CURRENCY_EXCHANGE_RATE) && CURRENCY_EXCHANGE_RATE > 0
    ? CURRENCY_EXCHANGE_RATE
    : 1;
  const converted = baseUsd * rate;

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

// Model curation / blocklist
// MODEL_BLOCKLIST lets you hide/deny specific Wiro models from this webapp
// without touching code - set it in Railway's environment variables as a
// comma-separated list of rules, e.g.:
//   MODEL_BLOCKLIST=xai/*, wiro/*, wiro-partners/*, category:nsfw, uncensored
// Supported rule forms (case-insensitive, whitespace trimmed):
//   owner/project  - blocks that exact model
//   owner/*        - blocks every model published by that owner
//   category:slug  - blocks every model tagged with that Wiro category
//   anything else  - treated as a free-text keyword: blocks any model whose
//                    slug, title, description, tags or categories contain it
//                    (e.g. "uncensored" to hide Wiro's "uncensored" models,
//                    which aren't a distinct owner/category to block by slug)
const MODEL_BLOCKLIST_RULES = parseModelBlocklist(process.env.MODEL_BLOCKLIST);

function parseModelBlocklist(raw) {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map(entry => entry.trim().toLowerCase())
    .filter(Boolean)
    .map(entry => {
      if (entry.startsWith('category:')) {
        return { type: 'category', value: entry.slice('category:'.length).trim() };
      }
      if (entry.includes('/')) {
        const [owner, project] = entry.split('/');
        return project === '*'
          ? { type: 'owner', value: owner }
          : { type: 'slug', value: `${owner}/${project}` };
      }
      return { type: 'keyword', value: entry };
    })
    .filter(rule => rule.value);
}

// Normalizes a raw Wiro tool/model object - whose field names differ
// slightly between /Tool/List (cleanslugowner/cleanslugproject) and
// /Tool/Detail (slugowner/slugproject) - into the handful of fields the
// blocklist rules above need to check against.
function getModelBlocklistFields(model) {
  const owner = String(model.cleanslugowner || model.slugowner || '').toLowerCase();
  const project = String(model.cleanslugproject || model.slugproject || '').toLowerCase();
  const slug = owner && project ? `${owner}/${project}` : '';
  const categories = (model.categories || []).map(c => String(c).toLowerCase());
  const tags = (model.tags || []).map(t => String(t).toLowerCase());
  const text = [model.title, model.seodescription, model.description]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return { owner, slug, categories, tags, text };
}

// True if this model's slug/categories/tags/description contain the given
// (already-lowercased) keyword value - the same matching logic a plain
// `keyword` MODEL_BLOCKLIST rule uses, factored out so it can be tested
// independently of the full blocklist decision (e.g. "is this model tagged
// 'uncensored'?" for the dedicated tag section below).
function modelMatchesKeywordValue(model, keywordValue) {
  const { slug, categories, tags, text } = getModelBlocklistFields(model);
  return slug.includes(keywordValue)
    || categories.some(c => c.includes(keywordValue))
    || tags.some(t => t.includes(keywordValue))
    || text.includes(keywordValue);
}

// True if any configured MODEL_BLOCKLIST rule matches this model - used to
// both filter the public /models list and to reject direct schema/generate
// requests for a model that isn't supposed to be reachable at all.
//
// `exceptKeyword` (already-lowercased) lets a caller ask "is this model
// blocked for any reason *other than* this specific keyword rule?" - used by
// the dedicated tag section (e.g. /models?tag=uncensored) so a model hidden
// from the normal catalog only by a `uncensored` keyword rule can still be
// reached there, while a model also hit by an unrelated slug/owner/category
// rule stays hidden everywhere (hard bans still win).
function isModelBlocked(model, { exceptKeyword } = {}) {
  if (MODEL_BLOCKLIST_RULES.length === 0) return false;
  const { owner, slug, categories, tags, text } = getModelBlocklistFields(model);
  const exceptValue = exceptKeyword ? String(exceptKeyword).trim().toLowerCase() : null;

  return MODEL_BLOCKLIST_RULES.some(rule => {
    switch (rule.type) {
      case 'slug':
        return slug === rule.value;
      case 'owner':
        return owner === rule.value;
      case 'category':
        return categories.includes(rule.value);
      case 'keyword':
        if (exceptValue && rule.value === exceptValue) return false;
        return modelMatchesKeywordValue(model, rule.value);
      default:
        return false;
    }
  });
}

// The subset of MODEL_BLOCKLIST rules that are bare keywords (not
// slug/owner/category) - these are the only ones a "tag page" like
// /models?tag=uncensored is allowed to relax, since they're the only rule
// type that represents a content label rather than a hard ban.
function getConfiguredKeywordTags() {
  return MODEL_BLOCKLIST_RULES.filter(rule => rule.type === 'keyword').map(rule => rule.value);
}

// Validates a client-supplied `tag` query/body param against the actually
// configured keyword rules, so a request can't use this to bypass an
// unrelated owner/slug/category ban by guessing arbitrary values. Returns
// the normalized keyword to pass as `exceptKeyword`, or undefined if the tag
// is missing/not a configured keyword (in which case the normal, full
// blocklist check applies).
function resolveExceptKeywordFromTag(rawTag) {
  if (!rawTag) return undefined;
  const normalized = String(rawTag).trim().toLowerCase();
  if (!normalized) return undefined;
  return getConfiguredKeywordTags().includes(normalized) ? normalized : undefined;
}

// Fast-path block check for a bare "owner/project" slug (e.g. from
// POST /generate, which only ever receives the slug string). Slug/owner
// rules can be checked without any extra Wiro call; category/keyword rules
// need the model's real metadata, so those only trigger a /Tool/Detail
// lookup when such a rule is actually configured.
async function isModelSlugBlocked(modelSlug, { exceptKeyword } = {}) {
  const [owner = '', project = ''] = String(modelSlug || '').toLowerCase().split('/');
  const slug = owner && project ? `${owner}/${project}` : '';

  const matchesSlugRule = MODEL_BLOCKLIST_RULES.some(rule => (
    (rule.type === 'slug' && rule.value === slug)
    || (rule.type === 'owner' && rule.value === owner)
  ));
  if (matchesSlugRule) return true;

  const exceptValue = exceptKeyword ? String(exceptKeyword).trim().toLowerCase() : null;
  const needsMetadataLookup = MODEL_BLOCKLIST_RULES.some(rule => (
    rule.type === 'category' || (rule.type === 'keyword' && rule.value !== exceptValue)
  ));
  if (!needsMetadataLookup) return false;

  try {
    const tool = await resolveModelDetail(modelSlug);
    return tool ? isModelBlocked(tool, { exceptKeyword }) : false;
  } catch {
    // Don't block generation just because the lookup to verify the
    // blocklist failed - fail open rather than breaking every generation.
    return false;
  }
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
    const { search, categories, slugowner, sort, start, limit, tag } = req.query;
    const requestedSort = String(sort || '').trim();

    // A `tag` query param reaches a dedicated, otherwise-hidden section of
    // the catalog (e.g. /models?tag=uncensored) - it must match one of the
    // actual `keyword` rules currently configured in MODEL_BLOCKLIST, so
    // this can't be used to bypass an arbitrary owner/slug/category ban by
    // guessing values.
    let requestedTag = null;
    if (tag !== undefined && String(tag).trim() !== '') {
      const normalizedTag = String(tag).trim().toLowerCase();
      if (!getConfiguredKeywordTags().includes(normalizedTag)) {
        return res.status(400).json({ error: `Unknown tag "${tag}". It isn't a configured MODEL_BLOCKLIST keyword.` });
      }
      requestedTag = normalizedTag;
    }

    // Cap the page size so a client-supplied `limit` can't force us to pull
    // (and re-serve) the entire 500+ model catalog in one response - the
    // whole point of paging is a small, fast payload per page.
    const requestedLimit = limit ? Number(limit) : 20;
    const safeLimit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 20;
    const requestedStart = start ? Number(start) : 0;
    const safeStart = Number.isFinite(requestedStart) && requestedStart >= 0 ? requestedStart : 0;

    const result = await client.searchModels({
      // When a tag is active, ask Wiro to actually search its whole catalog
      // for that keyword (falling back to the tag itself when the user
      // hasn't typed their own search term) - otherwise we'd only ever see
      // whichever handful of unrelated, default-sorted models happen to
      // land on this one page, making tag sections wildly undercount how
      // many matching models actually exist.
      search: (search || (requestedTag ? requestedTag : undefined)) || undefined,
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

    const rawTools = result.tool || [];
    // Drop anything matched by MODEL_BLOCKLIST before it ever reaches the
    // frontend, so blocked models are neither shown nor selectable - unless
    // a valid `tag` was requested, in which case only models actually
    // tagged with that keyword are shown (and only if they aren't *also*
    // hard-banned by an unrelated slug/owner/category rule). The keyword
    // check also acts as a safety net against Wiro's fuzzy `search` match
    // returning models that don't really carry the tag.
    const visibleTools = rawTools.filter(model => (
      requestedTag
        ? modelMatchesKeywordValue(model, requestedTag) && !isModelBlocked(model, { exceptKeyword: requestedTag })
        : !isModelBlocked(model)
    ));
    const blockedCount = rawTools.length - visibleTools.length;

    const models = visibleTools.map(model => ({
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
      // Best-effort: Wiro's `total` counts matches (across every page) for
      // the `search`/`categories`/`slugowner` filters actually sent above -
      // including the tag keyword we now pass as `search` when a tag is
      // active - but we only know which models on *this* page are blocked
      // or (for tag pages) false-positive keyword matches, so this slightly
      // overcounts when such models exist on other pages too.
      total: Math.max(0, (Number(result.total) || rawTools.length) - blockedCount),
      start: safeStart,
      limit: safeLimit,
      // Lets the frontend decide whether to show the "Uncensored"-style nav
      // link at all - apps that never set MODEL_BLOCKLIST to a keyword have
      // no tag pages to link to.
      availableTags: getConfiguredKeywordTags()
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
// Wiro's own run-time validation hard-caps `seed` at 0-9999999 regardless of
// whatever (often much larger, e.g. 2147483647) min/max a model's schema
// reports, which let the UI auto-generate a "valid-looking" random seed that
// Wiro then rejected with "Request parameter [seed] must be between 0 and
// 9999999". Force every seed field to Wiro's real accepted range.
const SEED_MIN = 0;
const SEED_MAX = 9999999;
// Common default for "Safety Tolerance" knobs (e.g. Flux-family image
// models), used only when Wiro reports no usable default of its own.
const DEFAULT_SAFETY_TOLERANCE = 2;
// Common square output resolution, used as a fallback default for bare
// width/height number fields that Wiro reports without a default.
const DEFAULT_IMAGE_DIMENSION = 1024;
// "Maximum number of output images" (e.g. SeeDream V4's `maxImages`) must be
// a whole number of at least 1 (0/negative makes no sense) and we cap it at
// 15 to keep batch-generation runs (and their cost) bounded, regardless of
// whatever wider/looser range Wiro's own schema reports.
const OUTPUT_IMAGE_COUNT_MIN = 1;
const OUTPUT_IMAGE_COUNT_MAX = 15;
const DEFAULT_OUTPUT_IMAGE_COUNT = 1;

// --- 3D model tools (text-to-3d / image-to-3d, e.g. Hunyuan3D, Tripo, Rodin) ---
// These models expose a handful of recurring "mesh quality" knobs that
// aren't seen on image/video tools, each with its own common Wiro naming
// variants. Giving every 3D tool the same sane baseline here (instead of
// leaving whatever Wiro reports, which is sometimes empty) means a user
// gets a usable default mesh/texture quality immediately, mirroring the
// defaults Wiro's own playground pre-fills.
const DEFAULT_TEXTURE_RESOLUTION = 1024;
const DEFAULT_MESH_RESOLUTION = 256; // e.g. "octree resolution" for marching-cubes mesh extraction
const DEFAULT_3D_OUTPUT_FORMAT = 'glb'; // Widely supported by in-browser viewers (incl. <model-viewer>)

function normalizeParameterItem(item) {
  const text = `${item.id || ''} ${item.label || ''}`.toLowerCase();
  const type = (item.type || '').toLowerCase();
  const isNumeric = type === 'number' || type === 'integer' || type === 'float';
  const isSeedField = /(^|[^a-z])seed([^a-z]|$)/.test(text);
  const isTextureResolutionField = /texture/.test(text) && /resolution/.test(text);
  const isMeshResolutionField = (/octree/.test(text) && /resolution/.test(text))
    || (/mesh/.test(text) && /resolution/.test(text));
  const isOutputFormatField = (/output/.test(text) && /format/.test(text)) || /\bformat\b/.test(text) && /\b3d|mesh|model|geometry\b/.test(text);

  // 3D "size"/"resolution" dropdowns (texture/mesh resolution presets) -
  // pick a sane mid-tier default instead of whatever option happens to be
  // first, same principle as the image size/resolution handling below.
  if (!isSeedField && Array.isArray(item.options) && item.options.length > 0) {
    const isSizeField = /\bsize\b/.test(text) || /\bresolution\b/.test(text)
      || (/\bwidth\b/.test(text) && /\bheight\b/.test(text));
    if (isSizeField) {
      const hasValidDefault = item.default != null
        && item.options.some(opt => String(opt.value) === String(item.default));
      if (!hasValidDefault) {
        const preferredSquare = item.options.find(opt => (
          /(^|[^0-9])1024x1024([^0-9]|$)/i.test(`${opt.value}`) || /square|\b1:1\b/i.test(`${opt.label || ''}`)
        ));
        return { ...item, default: (preferredSquare || item.options[0]).value };
      }
      return item;
    }
    if (isOutputFormatField) {
      // Prefer a widely-supported-for-in-browser-preview format (glb) when
      // Wiro doesn't already report a valid default, so the generated
      // result can be shown in the 3D viewer without extra user setup.
      const hasValidDefault = item.default != null
        && item.options.some(opt => String(opt.value) === String(item.default));
      if (!hasValidDefault) {
        const preferredGlb = item.options.find(opt => String(opt.value).toLowerCase() === DEFAULT_3D_OUTPUT_FORMAT);
        return { ...item, default: (preferredGlb || item.options[0]).value };
      }
    }
    return item;
  }

  if (!isNumeric) return item;

  const isDurationField = /duration/.test(text) || /\bsecond/.test(text);
  const isInferenceStepsField = /step/.test(text) && (/infer/.test(text) || /\bsteps?\b/.test(text));
  const isGuidanceScaleField = /guidance/.test(text);
  const isShiftField = /\bshift\b/.test(text);
  const isSafetyToleranceField = /safety/.test(text) && /toleran/.test(text);
  const isWidthField = /\bwidth\b/.test(text) && !/\bheight\b/.test(text);
  const isHeightField = /\bheight\b/.test(text) && !/\bwidth\b/.test(text);
  // Matches both the Wiro field id (e.g. `maxImages`, `numberOfOutputs`) and
  // its human label (e.g. "Maximum number of output images").
  const isOutputImageCountField = IMAGE_COUNT_PARAM_KEYS.includes(normalizePriceKey(item.id))
    || (/\bnumber\b/.test(text) && /\boutput/.test(text) && /\bimages?\b/.test(text))
    || (/\bmax(imum)?\b/.test(text) && /\bimages?\b/.test(text) && !isWidthField && !isHeightField);

  const normalized = { ...item };

  if (isSeedField) {
    normalized.type = type === 'float' ? type : 'integer';
    normalized.min = SEED_MIN;
    normalized.max = SEED_MAX;
    normalized.step = 1;
    const currentDefault = Number(normalized.default);
    if (!Number.isFinite(currentDefault) || currentDefault < SEED_MIN || currentDefault > SEED_MAX) {
      normalized.default = SEED_MIN;
    }
  } else if (isDurationField) {
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
  } else if (isSafetyToleranceField) {
    const currentDefault = Number(normalized.default);
    const min = Number(normalized.min);
    const max = Number(normalized.max);
    const currentIsValid = Number.isFinite(currentDefault)
      && (!Number.isFinite(min) || currentDefault >= min)
      && (!Number.isFinite(max) || currentDefault <= max);
    if (!currentIsValid) {
      normalized.default = Number.isFinite(min) && Number.isFinite(max) && max >= min
        ? Math.round((min + max) / 2)
        : DEFAULT_SAFETY_TOLERANCE;
    }
  } else if (isWidthField || isHeightField) {
    const currentDefault = Number(normalized.default);
    if (!Number.isFinite(currentDefault) || currentDefault <= 0) {
      normalized.default = DEFAULT_IMAGE_DIMENSION;
    }
  } else if (isTextureResolutionField) {
    const currentDefault = Number(normalized.default);
    if (!Number.isFinite(currentDefault) || currentDefault <= 0) {
      normalized.default = DEFAULT_TEXTURE_RESOLUTION;
    }
  } else if (isMeshResolutionField) {
    const currentDefault = Number(normalized.default);
    if (!Number.isFinite(currentDefault) || currentDefault <= 0) {
      normalized.default = DEFAULT_MESH_RESOLUTION;
    }
  } else if (isOutputImageCountField) {
    // Whole number of images only, bounded to 1-15 - no 0/negative counts
    // and no runaway batch sizes regardless of what Wiro's own schema reports.
    normalized.type = 'integer';
    normalized.min = OUTPUT_IMAGE_COUNT_MIN;
    normalized.max = OUTPUT_IMAGE_COUNT_MAX;
    normalized.step = 1;
    const currentDefault = Number(normalized.default);
    if (!Number.isFinite(currentDefault) || currentDefault < OUTPUT_IMAGE_COUNT_MIN || currentDefault > OUTPUT_IMAGE_COUNT_MAX) {
      normalized.default = DEFAULT_OUTPUT_IMAGE_COUNT;
    } else {
      normalized.default = Math.round(currentDefault);
    }
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
    const { model, params, tag } = req.query;

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
    // `tag` lets a model reached from a dedicated tag section (e.g.
    // /models?tag=uncensored) open its schema even though it'd otherwise be
    // 404'd by MODEL_BLOCKLIST - only honored when it matches an actually
    // configured keyword rule.
    const exceptKeyword = resolveExceptKeywordFromTag(tag);

    if (!tool || isModelBlocked(tool, { exceptKeyword })) {
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

    // `params` (the field defaults, or the user's in-progress selections
    // when re-fetched after an edit) lets the estimate reflect Wiro's real,
    // parameter-dependent pricing (e.g. per-second * duration) instead of
    // always showing the same static "starting from" baseline.
    const requestedParams = parsePriceEstimateParams(params);

    return res.json({
      slug: requestedModel,
      title: tool.title,
      description: tool.seodescription || tool.description || '',
      categories: (tool.categories || []).filter(c => c !== 'tool'),
      parameters,
      estimatedCost: formatEstimatedCost(tool, requestedParams)
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

// Shared by GET /models/schema and GET /models/estimate-cost: both accept an
// optional `params` query string (JSON-encoded object of the user's current
// form values) used to compute a parameter-aware cost estimate.
function parsePriceEstimateParams(rawParams) {
  if (!rawParams) return undefined;
  try {
    const parsed = JSON.parse(rawParams);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// Cost Re-Estimate Endpoint
// Wiro's pricing is rarely flat - it depends on the user's actual parameter
// selections (duration, resolution and similar). The initial estimate shown
// when a model is selected is a static baseline (field defaults aren't known
// yet at render time), so the frontend calls this lightweight endpoint
// whenever a relevant parameter changes to refresh the displayed estimate
// without re-fetching/re-rendering the whole schema/form.
app.get('/models/estimate-cost', async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

  try {
    const { model, params, tag } = req.query;

    if (!model) {
      return res.status(400).json({ error: 'Query parameter "model" is required (e.g. ?model=owner/project).' });
    }

    let requestedModel = String(model).trim();
    while (requestedModel.startsWith('/')) requestedModel = requestedModel.slice(1);
    while (requestedModel.endsWith('/')) requestedModel = requestedModel.slice(0, -1);

    const tool = await resolveModelDetail(requestedModel);
    const exceptKeyword = resolveExceptKeywordFromTag(tag);

    if (!tool || isModelBlocked(tool, { exceptKeyword })) {
      return res.status(404).json({ error: `Model "${requestedModel}" was not found.` });
    }

    const requestedParams = parsePriceEstimateParams(params);

    return res.json({ estimatedCost: formatEstimatedCost(tool, requestedParams) });
  } catch (error) {
    if (error instanceof WiroApiError) {
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
    const { model, prompt, tag, ...rest } = req.body || {};

    const selectedModel = model || 'alibaba/wan-2-7-image';

    // `tag` lets a model reached from a dedicated tag section (e.g. the
    // frontend's "Uncensored" nav entry) actually run, even though it'd
    // otherwise be blocked by MODEL_BLOCKLIST - only honored when it
    // matches an actually configured keyword rule, and destructured out of
    // `rest` above so it's never forwarded to Wiro as a model parameter.
    const exceptKeyword = resolveExceptKeywordFromTag(tag);

    // Enforce MODEL_BLOCKLIST here too - not just in GET /models - so a
    // blocked model can't be run by calling this endpoint directly with its
    // slug, bypassing the fact that the frontend never lists/offers it.
    if (await isModelSlugBlocked(selectedModel, { exceptKeyword })) {
      return res.status(403).json({ success: false, error: `Model "${selectedModel}" is not available.` });
    }

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

      // Defensive clamp: Wiro's run-time validation hard-caps `seed` at
      // 0-9999999 regardless of the (often larger) range its own schema
      // reports, which previously let an out-of-range value reach Wiro and
      // fail with "Request parameter [seed] must be between 0 and 9999999".
      if (/(^|[^a-z])seed([^a-z]|$)/i.test(key) && value !== '' && Number.isFinite(Number(value))) {
        options[key] = Math.min(9999999, Math.max(0, Math.round(Number(value))));
        continue;
      }

      // Defensive clamp: "Maximum number of output images" must be a whole
      // number between 1 and 15 - reject/clamp anything outside that range
      // even if a request bypasses the form's own min/max constraints.
      if (IMAGE_COUNT_PARAM_KEYS.includes(normalizePriceKey(key)) && value !== '' && Number.isFinite(Number(value))) {
        options[key] = Math.min(15, Math.max(1, Math.round(Number(value))));
        continue;
      }

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
