// Minimal CHIP (https://gate.chip-in.asia) Collect API client, mirroring
// the purchases endpoints of https://github.com/CHIPAsia/chip-nodejs-sdk.
const CHIP_BASE_URL = () => String(process.env.CHIP_BASE_URL || 'https://gate.chip-in.asia/api/v1').replace(/\/+$/, '');

// Credits are sold at 1 MYR = 1 credit. Only whole-ringgit amounts >= MIN are accepted.
export const MIN_TOPUP_MYR = 10;
export const MAX_TOPUP_MYR = 10000;
export const SUGGESTED_TOPUPS_MYR = [10, 20, 50, 100];

// Limited-time price slash: credits -> sale price in MYR. Ends at
// CHIP_SALE_ENDS_AT (ISO date, optional); set CHIP_SALE_ENABLED=false to turn off.
const SALE_PRICES_MYR = { 50: 45, 100: 80 };

export function isSaleActive(now = Date.now()) {
  if (String(process.env.CHIP_SALE_ENABLED || 'true').toLowerCase() === 'false') return false;
  const end = process.env.CHIP_SALE_ENDS_AT;
  if (!end) return true;
  const t = Date.parse(end);
  return Number.isFinite(t) && now < t;
}

// Price in MYR for a validated credit amount (1 credit = RM1 unless on sale).
export function priceForCredits(credits) {
  return isSaleActive() && SALE_PRICES_MYR[credits] !== undefined ? SALE_PRICES_MYR[credits] : credits;
}

// Returns the amount if valid, else null. Strict: only JSON numbers that are
// integers; strings, booleans, decimals, negatives, NaN/Infinity are rejected.
export function validateTopupAmount(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null;
  if (value < MIN_TOPUP_MYR || value > MAX_TOPUP_MYR) return null;
  return value;
}
export const CHIP_CURRENCY = 'MYR';

export function isChipConfigured() {
  return Boolean(process.env.CHIP_API_KEY && process.env.CHIP_BRAND_ID);
}

async function chipRequest(path, init = {}) {
  const res = await fetch(`${CHIP_BASE_URL()}${path}`, {
    ...init,
    headers: {
      Authorization: 'Bearer ' + process.env.CHIP_API_KEY,
      'Content-Type': 'application/json',
      ...(init.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data?.__all__?.[0]?.message || data?.detail || `CHIP request failed (${res.status})`;
    throw new Error(detail);
  }
  return data;
}

export function createPurchase({ email, productName, amountCents, reference, successRedirect, failureRedirect, successCallback }) {
  return chipRequest('/purchases/', {
    method: 'POST',
    body: JSON.stringify({
      brand_id: process.env.CHIP_BRAND_ID,
      client: { email },
      purchase: {
        currency: CHIP_CURRENCY,
        products: [{ name: productName, quantity: 1, price: amountCents }]
      },
      reference,
      success_redirect: successRedirect,
      failure_redirect: failureRedirect,
      success_callback: successCallback
    })
  });
}

export function getPurchase(id) {
  return chipRequest(`/purchases/${encodeURIComponent(id)}/`);
}
