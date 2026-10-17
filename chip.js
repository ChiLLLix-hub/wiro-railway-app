// Minimal CHIP (https://gate.chip-in.asia) Collect API client, mirroring
// the purchases endpoints of https://github.com/CHIPAsia/chip-nodejs-sdk.
const CHIP_BASE_URL = () => String(process.env.CHIP_BASE_URL || 'https://gate.chip-in.asia/api/v1').replace(/\/+$/, '');

export const CHIP_PACKAGES = {
  starter: { credits: 10, amountCents: 1000, label: 'Starter' },
  pro: { credits: 50, amountCents: 4500, label: 'Pro' },
  studio: { credits: 100, amountCents: 8000, label: 'Studio' }
};
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
