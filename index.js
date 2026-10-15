import express from 'express';
import cors from 'cors';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { randomBytes, randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { WiroClient, WiroApiError } from '@wiro-ai/wiro-mcp/client';
import { pool, isDbConfigured, initSchema, ensurePgCryptoExtension } from './db.js';
import { hashPassword, verifyPassword, issueToken, requireAuth, requireAdmin, findUserByEmail, findUserById, createUser, recordLoginAttempt, markUserLoggedIn } from './auth.js';
import { frontendBaseUrl, processNotificationOutbox, queueMail, queueOptInNotifications, sendTestEmail } from './notifications.js';

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

// Rate limiting: these routes perform authentication/authorization and/or
// database access against user accounts, so without a limit they'd be open
// to brute-force credential guessing and request-flooding. A tighter
// window is used for login/register (the most brute-forceable endpoints);
// a looser shared limit covers the rest of the authenticated API surface.
const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many attempts. Please try again later.' }
});

const apiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests. Please slow down.' }
});

const emailTestRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many email tests. Please try again later.' }
});

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

function createOpaqueToken() {
  return randomBytes(32).toString('hex');
}

async function createAccountToken(userId, purpose, lifetimeHours) {
  const token = createOpaqueToken();
  const tokenHash = await hashPassword(token);
  await pool.query(
    `DELETE FROM account_tokens WHERE user_id = $1 AND purpose = $2`,
    [userId, purpose]
  );
  await pool.query(
    `INSERT INTO account_tokens (token_hash, token_prefix, user_id, purpose, expires_at)
     VALUES ($1, $2, $3, $4, now() + ($5 * interval '1 hour'))`,
    [tokenHash, token.slice(0, 12), userId, purpose, lifetimeHours]
  );
  return token;
}

async function consumeAccountToken(token, purpose) {
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT token_hash, user_id FROM account_tokens
     WHERE token_prefix = $1 AND purpose = $2 AND expires_at > now()`,
    [String(token).slice(0, 12), purpose]
  );
  for (const candidate of rows) {
    if (!(await verifyPassword(String(token), candidate.token_hash))) continue;
    const { rows: consumed } = await pool.query(
      `DELETE FROM account_tokens WHERE token_hash = $1 AND expires_at > now() RETURNING user_id`,
      [candidate.token_hash]
    );
    return consumed[0] || null;
  }
  return null;
}

async function createIntegrationToken(userId, provider) {
  const token = createOpaqueToken();
  const tokenHash = await hashPassword(token);
  await pool.query(`DELETE FROM integration_link_tokens WHERE user_id = $1 AND provider = $2`, [userId, provider]);
  await pool.query(
    `INSERT INTO integration_link_tokens (token_hash, token_prefix, user_id, provider, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '15 minutes')`,
    [tokenHash, token.slice(0, 12), userId, provider]
  );
  return token;
}

async function consumeIntegrationToken(token, provider) {
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT token_hash, user_id FROM integration_link_tokens
     WHERE token_prefix = $1 AND provider = $2 AND expires_at > now()`,
    [String(token).slice(0, 12), provider]
  );
  for (const candidate of rows) {
    if (!(await verifyPassword(String(token), candidate.token_hash))) continue;
    const { rows: consumed } = await pool.query(
      `DELETE FROM integration_link_tokens WHERE token_hash = $1 AND expires_at > now() RETURNING user_id`,
      [candidate.token_hash]
    );
    return consumed[0] || null;
  }
  return null;
}

async function queueAccountEmail(userId, email, purpose, token) {
  const verification = purpose === 'email_verification';
  const subject = verification ? 'Verify your email address' : 'Reset your password';
  const link = verification
    ? `${frontendBaseUrl()}/?verifyToken=${encodeURIComponent(token)}`
    : `${frontendBaseUrl()}/?resetToken=${encodeURIComponent(token)}`;
  const message = verification
    ? 'Please verify your email address to activate your account.'
    : 'Use this link to reset your password. If you did not request a reset, you can ignore this email.';
  await queueMail({
    userId,
    eventKey: `${purpose}:${userId}:${randomUUID()}`,
    to: email,
    subject,
    message,
    link
  });
}

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

// ==================== AUTH / USER ACCOUNTS ====================
// A single shared Wiro API key backs every request this server makes, so
// without a local notion of "who is asking" any caller who knows/guesses a
// taskId could read another user's prompt and output (see /task/:taskId
// below). These endpoints establish that identity in Postgres.

// Deliberately not a regex (CodeQL flagged a regex-based check here as a
// potential ReDoS vector on user-controlled input) - a plain structural
// check is both simpler and immune to catastrophic backtracking.
function isValidEmail(value) {
  const email = String(value || '').trim();
  if (email.length < 3 || email.length > 254) return false;
  const atIndex = email.indexOf('@');
  if (atIndex <= 0 || atIndex !== email.lastIndexOf('@')) return false;
  const localPart = email.slice(0, atIndex);
  const domainPart = email.slice(atIndex + 1);
  if (!localPart || !domainPart) return false;
  if (/\s/.test(email)) return false;
  const dotIndex = domainPart.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === domainPart.length - 1) return false;
  return true;
}

// Postgres NUMERIC columns come back from `pg` as strings (to avoid float
// precision loss) - normalize to a JS number everywhere credits are
// exposed/compared so callers never need to remember to coerce it.
function toCreditsNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// ==================== CREDIT HOLD / ESCROW ====================
// Charging credits only once a generation finishes (as the previous
// implementation did) let a user with e.g. 1 credit fire off many
// concurrent generations in parallel - each one's own pre-check saw the
// same still-unspent balance before any of them had finished and deducted
// anything, so the "must have >= 1 credit" gate could be bypassed by
// racing requests. Instead, a hold (escrow) equal to the *estimated* cost
// is atomically deducted from the user's balance the moment a generation
// is accepted (see holdUserCredits below - the `AND credits >= $1` clause
// makes the check-and-deduct a single atomic statement, so concurrent
// requests against the same row are serialized by Postgres and can't both
// pass). The hold is then settled once the task finishes: refunded in full
// if the task failed, or trued up against the real `total_cost` if it
// succeeded (charging more if the final cost exceeds the hold, refunding
// the excess if it doesn't) - so the user is never charged before/without
// Wiro actually confirming a cost, but also can't dodge the real cost by
// only having it checked once upfront.

// Fallback hold amount when a model's cost can't be estimated ahead of
// time (formatEstimatedCost() returns null, e.g. no dynamicprice/cps/
// approximatelycost metadata available) - mirrors the previous "must have
// at least 1 credit" rule so there's always some hold in place rather than
// letting the request through with no hold at all.
const FALLBACK_HOLD_CREDITS = 1;

// Atomically attempts to place a hold of `amount` credits on `userId`'s
// balance. The `AND credits >= $1` condition and the UPDATE itself run as
// one statement, so Postgres takes a row lock on the user's row for the
// duration - a second concurrent call for the same user genuinely waits
// for the first to commit before it can see the now-reduced balance,
// closing the race that let multiple concurrent generations all pass a
// separate SELECT-then-check. Returns the new balance on success, or null
// if the user doesn't have enough credits available to hold.
async function holdUserCredits(userId, amount) {
  const { rows } = await pool.query(
    `UPDATE users SET credits = credits - $1, updated_at = now()
     WHERE id = $2 AND credits >= $1
     RETURNING credits`,
    [amount, userId]
  );
  return rows[0] ? toCreditsNumber(rows[0].credits) : null;
}

// Returns held credits to the user - used when a generation fails outright
// (Wiro rejected/errored the run) or when the task ultimately fails, so a
// hold is never kept without a corresponding real charge.
async function refundUserCredits(userId, amount) {
  if (!userId || !(amount > 0)) return;
  await pool.query(
    `UPDATE users SET credits = credits + $1, updated_at = now() WHERE id = $2`,
    [amount, userId]
  );
}

// Deducts an additional amount from the user's balance when a task's real
// cost exceeds what was held for it. Deliberately not gated on
// "credits >= amount" like holdUserCredits - the work has already been
// done and billed by Wiro, so unlike a *new* generation request this charge
// cannot be declined; it's allowed to take the balance negative, and the
// next generation attempt's own hold check will require the user to top up
// before they can start another job.
async function chargeAdditionalCredits(userId, amount) {
  if (!userId || !(amount > 0)) return;
  await pool.query(
    `UPDATE users SET credits = credits - $1, updated_at = now() WHERE id = $2`,
    [amount, userId]
  );
}

// Records an entry in the credit_transactions audit trail. Only used for
// out-of-band balance changes (admin adjustments, demo top-ups) - not for
// the per-generation hold/charge/refund flow, which is already tracked on
// generations.held_amount/total_cost.
async function recordCreditTransaction({ userId, amount, type, reason, createdBy }) {
  await pool.query(
    `INSERT INTO credit_transactions (user_id, amount, type, reason, created_by) VALUES ($1, $2, $3, $4, $5)`,
    [userId, amount, type, reason || null, createdBy || null]
  );
}

app.post('/auth/register', authRateLimiter, async (req, res) => {
  if (!isDbConfigured()) {
    return res.status(503).json({ success: false, error: 'Accounts are not configured on this server (DATABASE_URL missing).' });
  }

  try {
    const { email, password, displayName } = req.body || {};

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ success: false, error: 'A valid email is required.' });
    }
    if (!password || String(password).length < 8) {
      return res.status(400).json({ success: false, error: 'Password must be at least 8 characters.' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const existing = await findUserByEmail(normalizedEmail);
    if (existing) {
      return res.status(409).json({ success: false, error: 'An account with this email already exists.' });
    }

    const passwordHash = await hashPassword(String(password));
    const user = await createUser({ email: normalizedEmail, passwordHash, displayName: displayName || null });
    const token = await createAccountToken(user.id, 'email_verification', 24);
    await queueAccountEmail(user.id, user.email, 'email_verification', token);

    return res.status(201).json({
      success: true,
      message: 'Account created. Check your email for a verification link before logging in.'
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/auth/login', authRateLimiter, async (req, res) => {
  if (!isDbConfigured()) {
    return res.status(503).json({ success: false, error: 'Accounts are not configured on this server (DATABASE_URL missing).' });
  }

  const normalizedEmail = String(req.body?.email || '').trim().toLowerCase();
  const ip = req.ip;
  const userAgent = req.headers['user-agent'] || null;

  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      await recordLoginAttempt({ email: normalizedEmail, success: false, reason: 'missing_credentials', ip, userAgent });
      return res.status(400).json({ success: false, error: 'Email and password are required.' });
    }

    const user = await findUserByEmail(normalizedEmail);

    // A blacklisted email is rejected before anything else - this is a
    // permanent-until-an-admin-lifts-it denial (distinct from `is_active`,
    // which an admin can freely re-enable), so it must never be bypassed
    // by the generic "invalid email or password" branch below.
    if (user?.blacklisted) {
      await recordLoginAttempt({ email: normalizedEmail, success: false, reason: 'blacklisted', ip, userAgent });
      return res.status(403).json({ success: false, error: 'This account has been blocked. Please contact support.' });
    }

    // Use the same generic error for "no such user" and "wrong password" so
    // a login attempt can't be used to enumerate which emails are
    // registered.
    if (!user || !user.is_active || !(await verifyPassword(String(password), user.password_hash))) {
      await recordLoginAttempt({ email: normalizedEmail, success: false, reason: !user ? 'no_such_user' : (!user.is_active ? 'inactive' : 'bad_password'), ip, userAgent });
      return res.status(401).json({ success: false, error: 'Invalid email or password.' });
    }
    if (!user.email_verified) {
      await recordLoginAttempt({ email: normalizedEmail, success: false, reason: 'email_not_verified', ip, userAgent });
      return res.status(403).json({ success: false, error: 'Please verify your email before logging in.' });
    }

    await recordLoginAttempt({ email: normalizedEmail, success: true, ip, userAgent });
    await markUserLoggedIn(user.id);

    const token = issueToken(user);
    return res.json({
      success: true,
      token,
      user: { id: user.id, email: user.email, role: user.role, displayName: user.display_name }
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/auth/verify-email', authRateLimiter, async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ success: false, error: 'Accounts are not configured on this server.' });
  try {
    const token = String(req.body?.token || '');
    const verified = await consumeAccountToken(token, 'email_verification');
    if (!verified) return res.status(400).json({ success: false, error: 'This verification link is invalid or expired.' });
    await pool.query('UPDATE users SET email_verified = TRUE, updated_at = now() WHERE id = $1', [verified.user_id]);
    return res.json({ success: true, message: 'Email verified. You can now log in.' });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Could not verify email.' });
  }
});

app.post('/auth/forgot-password', authRateLimiter, async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ success: false, error: 'Accounts are not configured on this server.' });
  const email = String(req.body?.email || '').trim().toLowerCase();
  try {
    if (isValidEmail(email)) {
      const user = await findUserByEmail(email);
      if (user) {
        const token = await createAccountToken(user.id, 'password_reset', 1);
        await queueAccountEmail(user.id, user.email, 'password_reset', token);
      }
    }
    return res.json({ success: true, message: 'If an account exists for that address, a password-reset link has been sent.' });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Could not request a password reset.' });
  }
});

app.post('/auth/reset-password', authRateLimiter, async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ success: false, error: 'Accounts are not configured on this server.' });
  const token = String(req.body?.token || '');
  const password = String(req.body?.password || '');
  if (password.length < 8) return res.status(400).json({ success: false, error: 'Password must be at least 8 characters.' });
  try {
    const reset = await consumeAccountToken(token, 'password_reset');
    if (!reset) return res.status(400).json({ success: false, error: 'This password-reset link is invalid or expired.' });
    const passwordHash = await hashPassword(password);
    await pool.query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [passwordHash, reset.user_id]);
    return res.json({ success: true, message: 'Password updated. You can now log in.' });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Could not reset password.' });
  }
});

app.get('/me', apiRateLimiter, requireAuth, async (req, res) => {
  try {
    const user = await findUserById(req.user.id);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }
    return res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        displayName: user.display_name,
        credits: toCreditsNumber(user.credits),
        lastLoginAt: user.last_login_at
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

const NOTIFICATION_CHANNELS = ['email', 'telegram', 'discord'];
const NOTIFICATION_EVENTS = ['generation_success', 'demo_credit_added'];

app.get('/me/notification-settings', apiRateLimiter, requireAuth, async (req, res) => {
  try {
    const [{ rows: userRows }, { rows: preferenceRows }] = await Promise.all([
      pool.query('SELECT email, email_verified, telegram_chat_id, discord_user_id FROM users WHERE id = $1', [req.user.id]),
      pool.query('SELECT channel, event_type, enabled FROM user_notification_preferences WHERE user_id = $1', [req.user.id])
    ]);
    const preferences = Object.fromEntries(NOTIFICATION_CHANNELS.map(channel => [
      channel,
      Object.fromEntries(NOTIFICATION_EVENTS.map(event => [event, false]))
    ]));
    for (const row of preferenceRows) preferences[row.channel][row.event_type] = row.enabled;
    const user = userRows[0];
    return res.json({
      success: true,
      preferences,
      linked: {
        email: Boolean(user?.email_verified),
        telegram: Boolean(user?.telegram_chat_id),
        discord: Boolean(user?.discord_user_id)
      },
      emailVerified: Boolean(user?.email_verified)
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Could not load notification settings.' });
  }
});

app.post('/me/email-test', emailTestRateLimiter, requireAuth, async (req, res) => {
  const subject = String(req.body?.subject || '').trim();
  const message = String(req.body?.message || '').trim();
  if (!subject || subject.length > 120) {
    return res.status(400).json({ success: false, error: 'Enter a subject of 1–120 characters.' });
  }
  if (!message || message.length > 2000) {
    return res.status(400).json({ success: false, error: 'Enter a message of 1–2,000 characters.' });
  }

  let user;
  try {
    const { rows } = await pool.query(
      'SELECT email, email_verified FROM users WHERE id = $1',
      [req.user.id]
    );
    user = rows[0];
  } catch (error) {
    console.error('Could not load account email for SMTP test:', error.message);
    return res.status(500).json({ success: false, error: 'Could not check the account email.' });
  }
  if (!user) return res.status(404).json({ success: false, error: 'User not found.' });
  if (!user.email_verified) {
    return res.status(400).json({ success: false, error: 'Verify your account email before testing delivery.' });
  }

  try {
    await sendTestEmail({ to: user.email, subject, message });
    return res.json({ success: true, message: `Test email sent to ${user.email}. Check your inbox and spam folder.` });
  } catch (error) {
    const code = String(error.code || 'SMTP_DELIVERY_FAILED').slice(0, 40);
    const diagnostics = {
      code,
      message: code === 'EMAIL_SERVICE_NOT_CONFIGURED'
        ? error.message
        : code === 'EMAIL_SERVICE_TIMEOUT' || code === 'EMAIL_SERVICE_UNAVAILABLE'
          ? error.message
          : code === 'EMAIL_SERVICE_REJECTED'
            ? 'The email service rejected the request. Check its API key, endpoint, and logs.'
            : code === 'ETIMEDOUT' || code === 'ESOCKET'
              ? 'The SMTP connection timed out. Confirm the SMTP host and port, implicit TLS on port 465, and that the mail host allows connections from Railway.'
              : code === 'EAUTH'
                ? 'The mail server rejected authentication. Check the SMTP username and mailbox password.'
                : code === 'EMAIL_NOT_CONFIGURED'
                  ? error.message
                  : 'The email provider could not deliver the test message. Check the server logs and provider settings.'
    };
    console.error('SMTP email test failed:', { code });
    return res.status(502).json({
      success: false,
      error: 'Email test failed.',
      diagnostics
    });
  }
});

app.put('/me/notification-settings', apiRateLimiter, requireAuth, async (req, res) => {
  const preferences = req.body?.preferences;
  if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) {
    return res.status(400).json({ success: false, error: 'Notification preferences are required.' });
  }
  try {
    const { rows: users } = await pool.query(
      'SELECT email_verified, telegram_chat_id, discord_user_id FROM users WHERE id = $1',
      [req.user.id]
    );
    const user = users[0];
    for (const channel of NOTIFICATION_CHANNELS) {
      for (const event of NOTIFICATION_EVENTS) {
        const enabled = preferences[channel]?.[event];
        if (typeof enabled !== 'boolean') continue;
        if (enabled && !(channel === 'email' ? user?.email_verified
          : channel === 'telegram' ? user?.telegram_chat_id
            : user?.discord_user_id)) {
          return res.status(400).json({ success: false, error: `Link and verify ${channel} before enabling its notifications.` });
        }
        await pool.query(
          `INSERT INTO user_notification_preferences (user_id, channel, event_type, enabled)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, channel, event_type)
           DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
          [req.user.id, channel, event, enabled]
        );
        if (!enabled) {
          await pool.query(
            `DELETE FROM notification_outbox
             WHERE user_id = $1 AND channel = $2 AND event_type = $3 AND status IN ('pending', 'sending')`,
            [req.user.id, channel, event]
          );
        }
      }
    }
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Could not save notification settings.' });
  }
});

app.post('/me/integrations/telegram/link', apiRateLimiter, requireAuth, async (req, res) => {
  const botUsername = String(process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '');
  if (!botUsername || !process.env.TELEGRAM_BOT_TOKEN) {
    return res.status(503).json({ success: false, error: 'Telegram linking is not configured.' });
  }
  try {
    const token = await createIntegrationToken(req.user.id, 'telegram');
    return res.json({ success: true, url: `https://t.me/${encodeURIComponent(botUsername)}?start=${token}` });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Could not create Telegram link.' });
  }
});

app.post('/me/integrations/discord/link', apiRateLimiter, requireAuth, async (req, res) => {
  const clientId = process.env.DISCORD_CLIENT_ID;
  const redirectUri = process.env.DISCORD_REDIRECT_URI;
  if (!clientId || !process.env.DISCORD_CLIENT_SECRET || !redirectUri) {
    return res.status(503).json({ success: false, error: 'Discord linking is not configured.' });
  }
  try {
    const state = await createIntegrationToken(req.user.id, 'discord');
    const url = new URL('https://discord.com/oauth2/authorize');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'identify');
    url.searchParams.set('state', state);
    return res.json({ success: true, url: url.toString() });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Could not create Discord link.' });
  }
});

app.delete('/me/integrations/:provider', apiRateLimiter, requireAuth, async (req, res) => {
  const { provider } = req.params;
  if (!['telegram', 'discord'].includes(provider)) {
    return res.status(400).json({ success: false, error: 'Unknown integration.' });
  }
  const column = provider === 'telegram' ? 'telegram_chat_id' : 'discord_user_id';
  try {
    await pool.query(`UPDATE users SET ${column} = NULL WHERE id = $1`, [req.user.id]);
    await pool.query(
      'UPDATE user_notification_preferences SET enabled = FALSE, updated_at = now() WHERE user_id = $1 AND channel = $2',
      [req.user.id, provider]
    );
    await pool.query(
      `DELETE FROM notification_outbox
       WHERE user_id = $1 AND channel = $2 AND status IN ('pending', 'sending')`,
      [req.user.id, provider]
    );
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Could not unlink integration.' });
  }
});

app.get('/integrations/discord/callback', apiRateLimiter, async (req, res) => {
  const state = String(req.query.state || '');
  const code = String(req.query.code || '');
  const failUrl = `${frontendBaseUrl()}/dashboard.html?discord=error`;
  if (!state || !code || !process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET || !process.env.DISCORD_REDIRECT_URI) {
    return res.redirect(failUrl);
  }
  try {
    const link = await consumeIntegrationToken(state, 'discord');
    if (!link) return res.redirect(failUrl);

    const tokenResponse = await fetch('https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.DISCORD_REDIRECT_URI
      })
    });
    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenData.access_token) return res.redirect(failUrl);
    const profileResponse = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: 'Bearer ' + tokenData.access_token }
    });
    const profile = await profileResponse.json();
    if (!profileResponse.ok || !profile.id) return res.redirect(failUrl);
    await pool.query('UPDATE users SET discord_user_id = $1 WHERE id = $2', [profile.id, link.user_id]);
    return res.redirect(`${frontendBaseUrl()}/dashboard.html?discord=linked`);
  } catch (error) {
    console.error('Discord linking failed:', error);
    return res.redirect(failUrl);
  }
});

app.post('/integrations/telegram/webhook', apiRateLimiter, async (req, res) => {
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const receivedSecret = req.get('x-telegram-bot-api-secret-token');
  if (!expectedSecret || receivedSecret !== expectedSecret) return res.sendStatus(401);
  const text = String(req.body?.message?.text || '');
  const chatId = req.body?.message?.chat?.id;
  const match = /^\/start\s+([a-f0-9]{64})$/i.exec(text.trim());
  if (!match || chatId == null || req.body?.message?.chat?.type !== 'private') return res.sendStatus(200);
  try {
    const link = await consumeIntegrationToken(match[1], 'telegram');
    if (link) {
      await pool.query('UPDATE users SET telegram_chat_id = $1 WHERE id = $2', [String(chatId), link.user_id]);
      await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: 'Your account is now linked. You can manage notifications in your dashboard.' })
      });
    }
    return res.sendStatus(200);
  } catch (error) {
    console.error('Telegram linking failed:', error);
    return res.sendStatus(500);
  }
});

// Powers the user dashboard's overview cards: last login, current credit
// balance, how much has been spent today/this week/this month (derived
// from completed generations' real total_cost - not the in-flight hold
// amount), and the total number of generations run.
app.get('/me/summary', apiRateLimiter, requireAuth, async (req, res) => {
  try {
    const user = await findUserById(req.user.id);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    const { rows: spendRows } = await pool.query(
      `SELECT
         COALESCE(SUM(total_cost) FILTER (WHERE completed_at >= date_trunc('day', now())), 0) AS today,
         COALESCE(SUM(total_cost) FILTER (WHERE completed_at >= date_trunc('week', now())), 0) AS this_week,
         COALESCE(SUM(total_cost) FILTER (WHERE completed_at >= date_trunc('month', now())), 0) AS this_month,
         COUNT(*) AS total_generations
       FROM generations
       WHERE user_id = $1 AND status = 'completed'`,
      [req.user.id]
    );
    const spend = spendRows[0] || {};

    return res.json({
      success: true,
      summary: {
        credits: toCreditsNumber(user.credits),
        lastLoginAt: user.last_login_at,
        spendToday: toCreditsNumber(spend.today),
        spendThisWeek: toCreditsNumber(spend.this_week),
        spendThisMonth: toCreditsNumber(spend.this_month),
        totalGenerations: Number(spend.total_generations) || 0
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Demo-only credit top-up: no real payment processor is wired up yet, so
// this just lets a signed-in user add one of a few fixed credit packages
// directly to their balance. This exists purely so the "add credits" /
// payment redirect flow (triggered when a user has <1 credit) has
// somewhere real to send the user and something real to call - it must be
// replaced with an actual payment gateway integration before going live.
const DEMO_CREDIT_PACKAGES = { starter: 10, pro: 50, studio: 100 };

app.post('/me/credits/topup', apiRateLimiter, requireAuth, async (req, res) => {
  try {
    const { packageId } = req.body || {};
    const amount = DEMO_CREDIT_PACKAGES[packageId];
    if (!amount) {
      return res.status(400).json({ success: false, error: `Invalid package. Choose one of: ${Object.keys(DEMO_CREDIT_PACKAGES).join(', ')}.` });
    }

    const { rows } = await pool.query(
      `UPDATE users SET credits = credits + $1, updated_at = now() WHERE id = $2 RETURNING credits`,
      [amount, req.user.id]
    );
    if (!rows[0]) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    await recordCreditTransaction({ userId: req.user.id, amount, type: 'topup_demo', reason: `Demo top-up: ${packageId} package` });
    await queueOptInNotifications({
      userId: req.user.id,
      eventKey: `demo-credit:${req.user.id}:${randomUUID()}`,
      eventType: 'demo_credit_added',
      subject: 'Demo credits added',
      message: `Demo credits added for testing: ${amount} credits. No payment was processed.`,
      link: `${frontendBaseUrl()}/dashboard.html`
    });

    return res.json({ success: true, credits: toCreditsNumber(rows[0].credits), added: amount });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// A user's own generation history, so they never need to rely on
// remembering/sharing a raw Wiro taskId to revisit past jobs.
app.get('/me/generations', apiRateLimiter, requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, wiro_task_id, model_slug, model_tag, prompt, params, status, total_cost, held_amount, outputs, created_at, completed_at
       FROM generations WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [req.user.id]
    );
    return res.json({ success: true, generations: rows });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== ADMIN DASHBOARD ====================

// Admin-only: list all accounts, so support/ops can review or promote users
// without direct DB access. `search` matches email or display name
// (case-insensitive, partial match) so an admin can find a specific user
// without paging through the full list.
app.get('/admin/users', apiRateLimiter, requireAuth, requireAdmin, async (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    const params = [];
    let where = '';
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      where = `WHERE lower(email) LIKE $1 OR lower(COALESCE(display_name, '')) LIKE $1`;
    }

    const { rows } = await pool.query(
      `SELECT id, email, role, display_name, is_active, blacklisted, blacklist_reason, credits, last_login_at, created_at
       FROM users ${where} ORDER BY created_at DESC LIMIT 500`,
      params
    );
    return res.json({
      success: true,
      users: rows.map(u => ({ ...u, credits: toCreditsNumber(u.credits) }))
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.patch('/admin/users/:id/role', apiRateLimiter, requireAuth, requireAdmin, async (req, res) => {
  try {
    const { role } = req.body || {};
    if (role !== 'user' && role !== 'admin') {
      return res.status(400).json({ success: false, error: 'role must be "user" or "admin".' });
    }
    const { rows } = await pool.query(
      `UPDATE users SET role = $1, updated_at = now() WHERE id = $2 RETURNING id, email, role`,
      [role, req.params.id]
    );
    if (!rows[0]) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }
    return res.json({ success: true, user: rows[0] });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Admin-only: directly add or remove a user's credits, always requiring a
// reason so the resulting entry in `credit_transactions` is meaningful for
// later auditing (e.g. "refund for bug", "manual promo credit").
app.post('/admin/users/:id/credits', apiRateLimiter, requireAuth, requireAdmin, async (req, res) => {
  try {
    const amount = Number(req.body?.amount);
    const reason = String(req.body?.reason || '').trim();
    if (!Number.isFinite(amount) || amount === 0) {
      return res.status(400).json({ success: false, error: 'A non-zero numeric amount is required (positive to add, negative to remove).' });
    }
    if (!reason) {
      return res.status(400).json({ success: false, error: 'A reason is required for every manual credit adjustment.' });
    }

    const { rows } = await pool.query(
      `UPDATE users SET credits = credits + $1, updated_at = now() WHERE id = $2 RETURNING id, email, credits`,
      [amount, req.params.id]
    );
    if (!rows[0]) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    await recordCreditTransaction({ userId: req.params.id, amount, type: 'admin_adjust', reason, createdBy: req.user.id });

    return res.json({ success: true, user: { ...rows[0], credits: toCreditsNumber(rows[0].credits) } });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Admin-only: block/unblock toggles `is_active` - a blocked user keeps
// their account and data but can no longer log in (enforced in
// POST /auth/login). Distinct from blacklisting below, which is a
// stronger, reason-tracked, email-level denial.
app.post('/admin/users/:id/block', apiRateLimiter, requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE users SET is_active = FALSE, updated_at = now() WHERE id = $1 RETURNING id, email, is_active`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, error: 'User not found.' });
    return res.json({ success: true, user: rows[0] });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/admin/users/:id/unblock', apiRateLimiter, requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE users SET is_active = TRUE, updated_at = now() WHERE id = $1 RETURNING id, email, is_active`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, error: 'User not found.' });
    return res.json({ success: true, user: rows[0] });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Admin-only: blacklist/unblacklist by user id, recording why - a
// blacklisted account is rejected at login (see POST /auth/login) with a
// generic "blocked" message regardless of password correctness.
app.post('/admin/users/:id/blacklist', apiRateLimiter, requireAuth, requireAdmin, async (req, res) => {
  try {
    const reason = String(req.body?.reason || '').trim();
    if (!reason) {
      return res.status(400).json({ success: false, error: 'A reason is required to blacklist a user.' });
    }
    const { rows } = await pool.query(
      `UPDATE users SET blacklisted = TRUE, blacklist_reason = $1, updated_at = now() WHERE id = $2 RETURNING id, email, blacklisted, blacklist_reason`,
      [reason, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, error: 'User not found.' });
    return res.json({ success: true, user: rows[0] });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/admin/users/:id/unblacklist', apiRateLimiter, requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE users SET blacklisted = FALSE, blacklist_reason = NULL, updated_at = now() WHERE id = $1 RETURNING id, email, blacklisted`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, error: 'User not found.' });
    return res.json({ success: true, user: rows[0] });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Admin-only: generations across every user (not just the caller's own),
// so support/ops can look up a specific user's outputs without needing
// direct DB access. Optional `search` matches email, model slug or prompt.
app.get('/admin/generations', apiRateLimiter, requireAuth, requireAdmin, async (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    const params = [];
    let where = '';
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      where = `WHERE lower(u.email) LIKE $1 OR lower(COALESCE(g.model_slug, '')) LIKE $1 OR lower(COALESCE(g.prompt, '')) LIKE $1`;
    }

    const { rows } = await pool.query(
      `SELECT g.id, g.wiro_task_id, g.model_slug, g.prompt, g.status, g.total_cost, g.held_amount,
              g.outputs, g.created_at, g.completed_at, u.id AS user_id, u.email AS user_email
       FROM generations g
       JOIN users u ON u.id = g.user_id
       ${where}
       ORDER BY g.created_at DESC
       LIMIT 500`,
      params
    );
    return res.json({ success: true, generations: rows });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Admin-only: the manual-adjustment / demo-topup audit trail (see
// credit_transactions table) - "view last transaction" in the admin
// dashboard.
app.get('/admin/transactions', apiRateLimiter, requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.id, t.amount, t.type, t.reason, t.created_at,
              u.id AS user_id, u.email AS user_email,
              admin.id AS created_by_id, admin.email AS created_by_email
       FROM credit_transactions t
       JOIN users u ON u.id = t.user_id
       LEFT JOIN users admin ON admin.id = t.created_by
       ORDER BY t.created_at DESC
       LIMIT 200`
    );
    return res.json({ success: true, transactions: rows });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Admin-only: aggregate credit top-ups *and* spend (credits actually used
// on completed generations, across every user) today/this week/this
// month, plus the combined available user balance and headline counts.
// Demo top-ups are the only purchase flow currently supported; manual
// adjustments are excluded.
app.get('/admin/stats', apiRateLimiter, requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows: revenueRows } = await pool.query(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE created_at >= date_trunc('day', now())), 0) AS today,
         COALESCE(SUM(amount) FILTER (WHERE created_at >= date_trunc('week', now())), 0) AS this_week,
         COALESCE(SUM(amount) FILTER (WHERE created_at >= date_trunc('month', now())), 0) AS this_month
       FROM credit_transactions
       WHERE type = 'topup_demo' AND amount > 0`
    );
    // Across every user (not just one), how many credits were actually
    // spent on completed generations today/this week/this month - mirrors
    // the per-user query in GET /me/summary, just without the user_id filter.
    const { rows: spendRows } = await pool.query(
      `SELECT
         COALESCE(SUM(total_cost) FILTER (WHERE completed_at >= date_trunc('day', now())), 0) AS today,
         COALESCE(SUM(total_cost) FILTER (WHERE completed_at >= date_trunc('week', now())), 0) AS this_week,
         COALESCE(SUM(total_cost) FILTER (WHERE completed_at >= date_trunc('month', now())), 0) AS this_month
       FROM generations
       WHERE status = 'completed'`
    );
    const { rows: countRows } = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM users) AS total_users,
         (SELECT COALESCE(SUM(credits), 0) FROM users) AS total_unused_credits,
         (SELECT COUNT(*) FROM users WHERE is_active AND NOT blacklisted) AS active_users,
         (SELECT COUNT(*) FROM users WHERE blacklisted) AS blacklisted_users,
         (SELECT COUNT(*) FROM generations) AS total_generations,
         (SELECT COUNT(*) FROM generations WHERE status = 'pending') AS pending_generations,
         (SELECT COUNT(*) FROM generations WHERE status = 'failed') AS failed_generations`
    );
    const { rows: loginRows } = await pool.query(
      `SELECT COUNT(*) AS failed_logins_today
       FROM login_attempts
       WHERE NOT success AND created_at >= date_trunc('day', now())`
    );

    const revenue = revenueRows[0] || {};
    const spend = spendRows[0] || {};
    const counts = countRows[0] || {};
    const logins = loginRows[0] || {};

    return res.json({
      success: true,
      stats: {
        revenueToday: toCreditsNumber(revenue.today),
        revenueThisWeek: toCreditsNumber(revenue.this_week),
        revenueThisMonth: toCreditsNumber(revenue.this_month),
        spendToday: toCreditsNumber(spend.today),
        spendThisWeek: toCreditsNumber(spend.this_week),
        spendThisMonth: toCreditsNumber(spend.this_month),
        totalUnusedCredits: toCreditsNumber(counts.total_unused_credits),
        totalUsers: Number(counts.total_users) || 0,
        activeUsers: Number(counts.active_users) || 0,
        blacklistedUsers: Number(counts.blacklisted_users) || 0,
        totalGenerations: Number(counts.total_generations) || 0,
        pendingGenerations: Number(counts.pending_generations) || 0,
        failedGenerations: Number(counts.failed_generations) || 0,
        failedLoginsToday: Number(logins.failed_logins_today) || 0
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Admin-only: recent login attempts (success and failure) - optional
// `failedOnly=true` filters to just unsuccessful attempts, for spotting
// brute-force / credential-stuffing activity.
app.get('/admin/login-attempts', apiRateLimiter, requireAuth, requireAdmin, async (req, res) => {
  try {
    const failedOnly = String(req.query.failedOnly || '').toLowerCase() === 'true';
    const { rows } = await pool.query(
      `SELECT id, email, success, reason, ip, user_agent, created_at
       FROM login_attempts
       ${failedOnly ? 'WHERE NOT success' : ''}
       ORDER BY created_at DESC
       LIMIT 200`
    );
    return res.json({ success: true, attempts: rows });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Dynamic Model Execution Endpoint
app.post('/generate', apiRateLimiter, requireAuth, async (req, res) => {
  // Tracks whether a hold has been placed (and how much) so the catch
  // block below can always refund it if anything after the hold throws -
  // a hold must never be left deducted without either a generation record
  // to later settle it, or an immediate refund.
  let heldAmount = 0;
  let holdPlaced = false;

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

    // Estimate this run's cost the same way GET /models/estimate-cost does
    // (same model metadata + the caller's own parameter selections), so the
    // hold placed below tracks the real, parameter-aware price (duration,
    // resolution, image count, etc.) instead of a flat guess. Falls back to
    // FALLBACK_HOLD_CREDITS when no estimate is available at all (unknown
    // model, or a model with no dynamicprice/cps/approximatelycost data).
    let estimatedTool = null;
    try {
      estimatedTool = await resolveModelDetail(selectedModel);
    } catch {
      // Ignore - fall back to FALLBACK_HOLD_CREDITS below rather than
      // blocking generation just because the estimate lookup failed.
    }
    const estimate = estimatedTool ? formatEstimatedCost(estimatedTool, rest) : null;
    heldAmount = Number.isFinite(estimate?.estimatedAmount) && estimate.estimatedAmount > 0
      ? estimate.estimatedAmount
      : FALLBACK_HOLD_CREDITS;

    // Atomically check-and-deduct the hold in one statement (see
    // holdUserCredits above) - this is what actually prevents a user from
    // firing off several concurrent generations while low on credits: each
    // request's hold is serialized against the same balance, so only as
    // many can succeed as the user can actually afford, no matter how many
    // land at the same time.
    const balanceAfterHold = await holdUserCredits(req.user.id, heldAmount);
    if (balanceAfterHold === null) {
      return res.status(402).json({
        success: false,
        error: 'You have insufficient credits to generate. Please add credits to continue.',
        code: 'INSUFFICIENT_CREDITS',
        requiredCredits: heldAmount
      });
    }
    holdPlaced = true;

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
      // Wiro never accepted the job - give the held credits straight back,
      // there's nothing to settle later.
      await refundUserCredits(req.user.id, heldAmount);
      holdPlaced = false;
      return res.status(500).json({ error: run?.errors || 'Model execution failed' });
    }

    // Record ownership of this task *before* responding - this is what lets
    // GET /task/:taskId later verify that only the user who created a job
    // can look up its prompt/output, instead of the taskId alone acting as
    // a de-facto bearer token against Wiro's shared API key. `held_amount`
    // is stored here too so /task/:taskId can settle (refund or charge the
    // difference) against exactly what was put on hold for this job.
    try {
      await pool.query(
        `INSERT INTO generations (user_id, wiro_task_id, model_slug, model_tag, prompt, params, status, held_amount)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
         ON CONFLICT (wiro_task_id) DO NOTHING`,
        [req.user.id, run.taskid, selectedModel, typeof tag === 'string' ? tag : null, options.prompt, rest, heldAmount]
      );
    } catch (dbError) {
      // Don't fail the whole generation if the ownership record can't be
      // written - but log loudly, since GET /task/:taskId will then deny
      // the owner access to their own job until this is fixed, and the
      // hold placed above won't have anywhere to be settled against.
      console.error('Failed to record generation ownership:', dbError);
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
      socketaccesstoken: run.socketaccesstoken,
      heldCredits: heldAmount,
      credits: balanceAfterHold
    });
  } catch (error) {
    // Any unexpected failure after the hold was placed (e.g. client.runModel
    // threw, or something above it did) must still refund the hold - a
    // generation that never actually started must never keep a user's
    // credits.
    if (holdPlaced) {
      await refundUserCredits(req.user.id, heldAmount).catch(refundError => {
        console.error('Failed to refund credit hold after an error:', refundError);
      });
    }
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
//
// IMPORTANT: this server uses a single shared Wiro API key for every user,
// so a taskId alone is not a secret - Wiro itself will happily return any
// task's prompt/output to whoever asks. Ownership is therefore enforced
// locally (via the `generations` table written by POST /generate) *before*
// ever calling Wiro, so one user can never fetch another user's job by
// guessing/sharing a taskId.
app.get('/task/:taskId', apiRateLimiter, requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

  try {
    const taskId = String(req.params.taskId || '').trim();
    if (!taskId) {
      return res.status(400).json({ success: false, error: 'A task ID is required.' });
    }

    const { rows } = await pool.query(
      'SELECT user_id, held_amount FROM generations WHERE wiro_task_id = $1',
      [taskId]
    );
    const ownerRecord = rows[0];

    // Deny existence of the task to anyone but its owner (or an admin) -
    // returning the same 404 whether the taskId is unknown or belongs to
    // someone else, so this endpoint can't be used to enumerate/confirm
    // other users' task IDs either.
    if (!ownerRecord || (ownerRecord.user_id !== req.user.id && req.user.role !== 'admin')) {
      return res.status(404).json({ success: false, error: `No task found for ID "${taskId}".` });
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
      let settledCredits = null;

      try {
        // Only transition status -> 'completed' (and settle the hold) the
        // first time this task is observed as finished - this endpoint is
        // polled repeatedly while/after a job runs, and task.pexit stays
        // '0' on every subsequent poll, so without the `status <> 'completed'`
        // guard the hold would be settled again on every poll.
        const { rows: completedRows } = await pool.query(
          `UPDATE generations SET status = 'completed', total_cost = $1, outputs = $2, completed_at = now()
           WHERE wiro_task_id = $3 AND status <> 'completed'
           RETURNING user_id, held_amount`,
          [taskCost.finalAmount, JSON.stringify(downloadableOutputs), taskId]
        );

        const settlement = completedRows[0];
        if (settlement) {
          // Settle the hold placed at submission time against the real,
          // final cost: a flat 1:1 charge-on-completion (the old behavior)
          // let a user bank on a generation finishing to "prove" they had
          // credits, then start several more in parallel before any of
          // them settled - holding the *estimate* upfront (see
          // holdUserCredits in POST /generate) closes that gap, and this
          // is where the estimate gets trued up to what Wiro actually
          // charged: refund the unused portion if the final cost came in
          // under the hold, or charge the difference if it came in over.
          const held = toCreditsNumber(settlement.held_amount);
          const finalCost = Number.isFinite(taskCost.finalAmount) && taskCost.finalAmount > 0
            ? taskCost.finalAmount
            : 0;
          const difference = finalCost - held;

          if (difference > 0) {
            await chargeAdditionalCredits(settlement.user_id, difference);
          } else if (difference < 0) {
            await refundUserCredits(settlement.user_id, -difference);
          }

          try {
            await queueOptInNotifications({
              userId: settlement.user_id,
              eventKey: `generation-success:${taskId}`,
              eventType: 'generation_success',
              subject: 'Your generation is ready',
              message: 'Your AI generation completed successfully. Open the result here:',
              link: mediaOutput?.url || `${frontendBaseUrl()}/dashboard.html`
            });
          } catch (notificationError) {
            console.error('Could not queue generation notification:', notificationError);
          }

          if (settlement.user_id === req.user.id) {
            const { rows: balanceRows } = await pool.query('SELECT credits FROM users WHERE id = $1', [settlement.user_id]);
            settledCredits = balanceRows[0] ? toCreditsNumber(balanceRows[0].credits) : null;
          }
        }
      } catch (dbError) {
        console.error('Failed to update generation record on completion:', dbError);
      }
      if (settledCredits == null && ownerRecord.user_id === req.user.id) {
        const { rows: balanceRows } = await pool.query('SELECT credits FROM users WHERE id = $1', [req.user.id]);
        settledCredits = balanceRows[0] ? toCreditsNumber(balanceRows[0].credits) : null;
      }

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
        task: task,
        ...(settledCredits != null ? { credits: settledCredits } : {})
      });
    }

    const failureReason = extractFailureReason(task);
    let creditsAfterRefund = null;
    try {
      // Guard against double-refunding the hold: this endpoint is polled
      // repeatedly, and a failed task can also be revisited later via
      // "retrieve a previous generation" - only the transition into
      // 'failed' (never already 'failed' or 'completed') should trigger a
      // refund.
      const { rows: failedRows } = await pool.query(
        `UPDATE generations SET status = 'failed', completed_at = now()
         WHERE wiro_task_id = $1 AND status NOT IN ('failed', 'completed')
         RETURNING user_id, held_amount`,
        [taskId]
      );

      const refundTarget = failedRows[0];
      if (refundTarget) {
        const held = toCreditsNumber(refundTarget.held_amount);
        // The task never produced a billable result, so the full hold
        // placed at submission time is returned in full - the user is
        // never charged for a generation that failed.
        await refundUserCredits(refundTarget.user_id, held);

        if (refundTarget.user_id === req.user.id) {
          const { rows: balanceRows } = await pool.query('SELECT credits FROM users WHERE id = $1', [refundTarget.user_id]);
          creditsAfterRefund = balanceRows[0] ? toCreditsNumber(balanceRows[0].credits) : null;
        }
      }
    } catch (dbError) {
      console.error('Failed to update generation record on failure:', dbError);
    }
    if (creditsAfterRefund == null && ownerRecord.user_id === req.user.id) {
      const { rows: balanceRows } = await pool.query('SELECT credits FROM users WHERE id = $1', [req.user.id]);
      creditsAfterRefund = balanceRows[0] ? toCreditsNumber(balanceRows[0].credits) : null;
    }

    return res.status(200).json({
      success: false,
      error: failureReason,
      debugOutput: task.debugoutput,
      taskId: task.id,
      task: task,
      ...(creditsAfterRefund != null ? { credits: creditsAfterRefund } : {})
    });
  } catch (error) {
    if (error instanceof WiroApiError) {
      return res.status(error.status).json({ success: false, error: error.message });
    }
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

let generationCheckerRunning = false;

async function checkPendingGenerations() {
  if (!pool || generationCheckerRunning) return;
  generationCheckerRunning = true;
  try {
    const { rows } = await pool.query(
      `SELECT wiro_task_id, user_id, held_amount FROM generations
       WHERE status = 'pending' AND created_at > now() - interval '7 days'
         AND (last_polled_at IS NULL OR last_polled_at < now() - interval '45 seconds')
       ORDER BY last_polled_at NULLS FIRST, created_at ASC LIMIT 15`
    );
    for (const generation of rows) {
      try {
        const { rows: claimed } = await pool.query(
          `UPDATE generations SET last_polled_at = now()
           WHERE wiro_task_id = $1 AND status = 'pending'
             AND (last_polled_at IS NULL OR last_polled_at < now() - interval '45 seconds')
           RETURNING wiro_task_id`,
          [generation.wiro_task_id]
        );
        if (!claimed[0]) continue;
        const detail = await client.getTask({ taskid: generation.wiro_task_id });
        const task = detail.result ? (detail.tasklist || [])[0] : null;
        if (!task || isTaskPending(task)) continue;

        if (task.pexit === '0') {
          const outputs = normalizeTaskOutputs(task.outputs || []);
          const taskCost = formatTaskCost(task);
          const { rows: changed } = await pool.query(
            `UPDATE generations SET status = 'completed', total_cost = $1, outputs = $2, completed_at = now()
             WHERE wiro_task_id = $3 AND status = 'pending'
             RETURNING user_id, held_amount`,
            [taskCost.finalAmount, JSON.stringify(outputs), generation.wiro_task_id]
          );
          const completed = changed[0];
          if (!completed) continue;
          const held = toCreditsNumber(completed.held_amount);
          const finalCost = Number.isFinite(taskCost.finalAmount) && taskCost.finalAmount > 0 ? taskCost.finalAmount : 0;
          if (finalCost > held) await chargeAdditionalCredits(completed.user_id, finalCost - held);
          else if (finalCost < held) await refundUserCredits(completed.user_id, held - finalCost);
          try {
            await queueOptInNotifications({
              userId: completed.user_id,
              eventKey: `generation-success:${generation.wiro_task_id}`,
              eventType: 'generation_success',
              subject: 'Your generation is ready',
              message: 'Your AI generation completed successfully. Open the result here:',
              link: outputs[0]?.url || `${frontendBaseUrl()}/dashboard.html`
            });
          } catch (error) {
            console.error('Could not queue background generation notification:', error);
          }
        } else {
          const { rows: changed } = await pool.query(
            `UPDATE generations SET status = 'failed', completed_at = now()
             WHERE wiro_task_id = $1 AND status = 'pending'
             RETURNING user_id, held_amount`,
            [generation.wiro_task_id]
          );
          if (changed[0]) await refundUserCredits(changed[0].user_id, toCreditsNumber(changed[0].held_amount));
        }
      } catch (error) {
        console.error(`Could not check generation ${generation.wiro_task_id}:`, error);
      }
    }
  } finally {
    generationCheckerRunning = false;
  }
}

app.listen(PORT, async () => {
  try {
    await ensurePgCryptoExtension();
    await initSchema();
    await checkPendingGenerations();
    await processNotificationOutbox();
    setInterval(() => checkPendingGenerations(), 30_000);
    setInterval(() => processNotificationOutbox().catch(error => console.error('Notification worker failed:', error)), 15_000);
  } catch (error) {
    console.error('Failed to initialize database schema:', error);
  }
  console.log(`Server is running on port ${PORT}`);
});
