---
name: chip-payment-gateway-integration
description: Use this skill whenever the user wants to integrate CHIP (chip-in.asia) payment gateway into their application. Trigger this skill for any task involving CHIP API setup, creating purchases, handling payment callbacks, configuring webhooks, verifying signatures, going live, or troubleshooting CHIP payment flows — even if the user just says "add payments", "accept FPX/eWallet/card payments", or "integrate CHIP". This skill covers backend API integration in a language-agnostic way.
---

# CHIP Payment Gateway — Backend Integration Skill

CHIP (chip-in.asia) is a Malaysian digital finance platform supporting FPX, credit/debit cards, e-wallets (Touch 'n Go, GrabPay, Boost), and DuitNow QR. This skill covers end-to-end backend API integration.

> **Always integrate from the server side.** CHIP does not enable CORS — never expose your secret key to the browser/client.

---

## 📐 API Schema — Fetch, Don't Remember

The authoritative source of truth for every endpoint is the CHIP
Collect OpenAPI spec:

- **OpenAPI YAML:** https://docs.chip-in.asia/openapi/chip-collect.yaml
- **Rendered reference:** https://docs.chip-in.asia/chip-collect/api-reference/purchases/create

**Do not hardcode endpoint paths in your integration code.** When
you need an endpoint:

1. Fetch the spec (or the rendered reference) and copy the path
   verbatim.
2. If a path you "remember" isn't in the spec, the spec wins —
   your memory is wrong.
3. If you build a client library, generate it from the spec (e.g.
   with `openapi-generator` or `orval`) rather than writing paths
   by hand.

The endpoints referenced in this file (Create Purchase, Retrieve
Purchase, Refund, etc.) are kept here as **worked examples**, not
as the canonical list. Always cross-check the spec.

---

## ⚡ Before You Begin — Clarify Intent

**Always ask the user this before writing any code:**

> "Are you looking to:
> 1. **Integrate CHIP into your actual system** (real backend endpoint, production/staging setup), or
> 2. **Generate a dummy/test checkout link** to quickly verify the API works before building anything?
>
> 💡 If you're just exploring or haven't set up a backend yet, I recommend starting with **sandbox testing** — you can generate a real CHIP checkout link with test credentials in minutes, no backend needed."

---

### Path A — Sandbox / Dummy Link (Recommended Starting Point)

Use this when the user wants to quickly test CHIP without a full backend. Guide them to:

1. Log in to https://portal.chip-in.asia/collect → **Developers** → enable **Test Mode**
2. Copy their **Test Mode API Key** (Secret Key) and **Brand ID**

> ⚠️ **Use the Test Mode API key, not your live key.** The Merchant Portal shows a different Secret Key when Test Mode is toggled ON — that is your test key. Using your live key here may trigger real charges. When in doubt, the test key is usually prefixed or labelled differently in the portal.

3. Make a single `curl` or REST client (Postman / Insomnia / Thunder Client) call:

```bash
curl -X POST https://gate.chip-in.asia/api/v1/purchases/ \
  -H "Authorization: Bearer <TEST_SECRET_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "client": { "email": "test@example.com" },
    "purchase": {
      "currency": "MYR",
      "products": [{ "name": "Test Item", "price": 100, "quantity": 1 }]
    },
    "brand_id": "<BRAND_ID>",
    "success_callback": "https://example.com/success",
    "failure_callback": "https://example.com/failure"
  }'
```

4. Copy the `checkout_url` from the response and open it in a browser
5. Complete a test payment using CHIP's sandbox test credentials (shown on the payment page)

> ✅ No server required. No code required. Great for validating credentials and seeing the payment flow end-to-end before building.

**Once the user is happy with sandbox testing, suggest moving to Path B.**

---

### Path B — Full System Integration

Proceed with the steps below to wire CHIP into a real backend.

---

## Quick Reference

| Item | Value |
|---|---|
| Base URL | `https://gate.chip-in.asia/api/v1/` |
| Auth | `Authorization: Bearer <YOUR_SECRET_KEY>` |
| Content-Type | `application/json` |
| OpenAPI spec | https://docs.chip-in.asia/openapi/chip-collect.yaml |
| Docs | https://docs.chip-in.asia/chip-collect/api-reference/purchases/create |
| GitHub SDKs | https://github.com/CHIPAsia |

---

## Step 1 — Get Your Credentials & Generate `.env`

1. Sign up / log in at https://portal.chip-in.asia
2. Go to **Developers** tab in the Merchant Portal
3. Toggle **Test Mode** ON — the portal will now display your **Test Mode API key**
4. Copy your **Test Mode Secret Key** (for API auth) and **Test Mode Public Key** (for webhook verification)
5. Note your **Brand ID** (same Brand ID is used for both test and live)

> ⚠️ **Always use the Test Mode API key during development.** CHIP issues a separate Secret Key and Public Key for Test Mode vs Live Mode — they are not interchangeable. Using your live key in development risks real charges.

> 💡 **Sandbox vs Live:** Test Mode credentials only simulate payments — no real money moves. Always develop with Test Mode ON, then swap to live credentials only when deploying to production.

**Generate these two files in the project root:**

`.env` — empty values for the user to fill in, must never be committed:
```
# .env
# CHIP Payment Gateway — Test Mode credentials
# Get these from https://portal.chip-in.asia/collect → Developers (toggle Test Mode ON)
# ⚠️ Never commit this file. Make sure .env is in your .gitignore.

CHIP_SECRET_KEY=
CHIP_PUBLIC_KEY=
CHIP_BRAND_ID=
```

`.env.example` — safe placeholder to commit to version control:
```
# .env.example
# Copy this file to .env and fill in your credentials from https://portal.chip-in.asia
CHIP_SECRET_KEY=your_test_mode_secret_key_here
CHIP_PUBLIC_KEY=your_test_mode_public_key_here
CHIP_BRAND_ID=your_brand_id_here
```

> ✅ Ensure `.env` is listed in `.gitignore`. If a `.gitignore` doesn't exist yet, create one and add `.env` to it.

When going live, replace the values in `.env` with Live Mode credentials (toggle Test Mode OFF in the portal to reveal them).

---

## Step 2 — Create a Purchase

This is the core API call. Your server creates a purchase object and returns a `checkout_url` to redirect the customer.

### Endpoint
```
POST https://gate.chip-in.asia/api/v1/purchases/
```

### Required Headers
```
Authorization: Bearer <CHIP_SECRET_KEY>
Content-Type: application/json
```

### Minimal Request Body
```json
{
  "client": {
    "email": "customer@example.com"
  },
  "purchase": {
    "currency": "MYR",
    "products": [
      {
        "name": "Order #1234",
        "price": 5000,
        "quantity": 1
      }
    ]
  },
  "brand_id": "<CHIP_BRAND_ID>",
  "success_callback": "https://yoursite.com/payment/success",
  "failure_callback": "https://yoursite.com/payment/failure",
  "cancel_callback": "https://yoursite.com/payment/cancel"
}
```

> **Note:** `price` is in **cents** (e.g. `5000` = RM 50.00)

### Success Response (HTTP 201)
```json
{
  "id": "abc123-purchase-id",
  "checkout_url": "https://gate.chip-in.asia/p/abc123/",
  "status": "created"
}
```

**Redirect the user to `checkout_url`** to complete payment on CHIP's hosted page.

---

## Step 2.5 — Generate a Test Script (Verify Setup Works)

**Always generate a standalone test script** alongside the integration code. This lets the user verify their `.env` credentials and API connectivity before wiring up the full UI.

The test script must:
- Load `CHIP_SECRET_KEY` and `CHIP_BRAND_ID` from `.env`
- Call `POST /purchases/` with a hardcoded dummy payload (RM 1.00 test item)
- Print the `checkout_url` to the console on success
- Print a clear error message on failure

Generate the script in the language that matches the user's project stack.

**Node.js** — save as `test-chip.js`:
```js
require('dotenv').config();
const https = require('https');

const payload = JSON.stringify({
  client: { email: 'test@example.com' },
  purchase: {
    currency: 'MYR',
    products: [{ name: 'Test Item', price: 100, quantity: 1 }]
  },
  brand_id: process.env.CHIP_BRAND_ID,
  success_callback: 'https://example.com/success',
  failure_callback: 'https://example.com/failure'
});

const options = {
  hostname: 'gate.chip-in.asia',
  path: '/api/v1/purchases/',
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${process.env.CHIP_SECRET_KEY}`,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  }
};

const req = https.request(options, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const json = JSON.parse(data);
      if (json.checkout_url) {
        console.log('\n✅ CHIP credentials are working!');
        console.log('👉 Open this URL in your browser to test the payment flow:');
        console.log('\n' + json.checkout_url + '\n');
      } else {
        console.error('\n❌ Something went wrong:');
        console.error(JSON.stringify(json, null, 2));
      }
    } catch (e) {
      console.error('\n❌ Failed to parse response:', data);
    }
  });
});

req.on('error', e => console.error('❌ Request failed:', e.message));
req.write(payload);
req.end();
```

**Python** — save as `test_chip.py`:
```python
import os, json, urllib.request
from dotenv import load_dotenv

load_dotenv()

payload = json.dumps({
    "client": {"email": "test@example.com"},
    "purchase": {
        "currency": "MYR",
        "products": [{"name": "Test Item", "price": 100, "quantity": 1}]
    },
    "brand_id": os.getenv("CHIP_BRAND_ID"),
    "success_callback": "https://example.com/success",
    "failure_callback": "https://example.com/failure"
}).encode()

req = urllib.request.Request(
    "https://gate.chip-in.asia/api/v1/purchases/",
    data=payload,
    headers={
        "Authorization": f"Bearer {os.getenv('CHIP_SECRET_KEY')}",
        "Content-Type": "application/json"
    }
)

try:
    with urllib.request.urlopen(req) as res:
        data = json.loads(res.read())
        print("\n✅ CHIP credentials are working!")
        print("👉 Open this URL in your browser to test the payment flow:")
        print(f"\n{data['checkout_url']}\n")
except Exception as e:
    print(f"\n❌ Something went wrong: {e}")
```

**After generating the test script, instruct the user:**
> 1. Fill in `CHIP_SECRET_KEY` and `CHIP_BRAND_ID` in your `.env` file (leave `CHIP_PUBLIC_KEY` for now — only needed for webhooks)
> 2. Run: `node test-chip.js` or `python test_chip.py`
> 3. A `checkout_url` will be printed — open it in your browser
> 4. Complete a test payment to confirm the full flow works end-to-end
> 5. Once confirmed ✅, delete the test script before deploying to production

---

## Step 3 — Handle Payment Result

There are two complementary methods. **Implement both** for reliability.

### Method A: Return URL (Browser Redirect)

After payment, CHIP redirects the user to your `success_callback` / `failure_callback` URL with query parameters:

```
https://yoursite.com/payment/success?id=abc123&status=paid
```

Use the `id` to look up the purchase and verify status server-side (do not trust client-side data alone).

### Method B: Webhook (Server-to-Server) — Recommended

Configure a webhook in your Merchant Portal → Developers → Webhooks. CHIP will POST to your callback URL for events like `purchase.paid`.

**Webhook payload example:**
```json
{
  "event_type": "purchase.paid",
  "object": {
    "id": "abc123",
    "status": "paid",
    "purchase": { },
    "client": { }
  },
  "is_test": false
}
```

> Use webhooks as the **source of truth** — return URLs can fail if the user closes the browser before redirect.

---

## Step 4 — Verify Webhook Signature

All CHIP webhook deliveries include an `X-Signature` header. Always verify it before processing.

**Verification logic (pseudocode):**
```
1. Read raw request body (as bytes — do not parse JSON first)
2. Base64-decode the X-Signature header
3. Verify the signature against the raw body using:
   - Algorithm: RSA PKCS#1 v1.5
   - Digest: SHA-256
   - Key: CHIP_PUBLIC_KEY from .env
4. If verification fails → return HTTP 200 but skip processing
```

**Important:** Return `HTTP 200` even when rejecting invalid signatures — CHIP retries on non-200 responses.

---

## Step 5 — Retrieve a Purchase

To verify payment status server-side at any point:

```
GET https://gate.chip-in.asia/api/v1/purchases/<purchase_id>/
Authorization: Bearer <CHIP_SECRET_KEY>
```

Check the `status` field:

| Status | Meaning |
|---|---|
| `created` | Purchase created, awaiting payment |
| `paid` | Payment successful ✅ |
| `failed` | Payment failed |
| `cancelled` | Cancelled by user |
| `hold` | Pre-authorized, not yet captured |

---

## Step 6 — Go Live Checklist

> 🧪 **Complete all sandbox testing before switching to live credentials.**

- [ ] `.env` created with Test Mode credentials and added to `.gitignore`
- [ ] Test script ran successfully and `checkout_url` opened in browser
- [ ] Full payment flow tested in sandbox (success, failure, cancel)
- [ ] Webhook signature verification tested with test deliveries
- [ ] Test script deleted before production deploy
- [ ] Switch `.env` values to **Live Mode credentials** from Merchant Portal (toggle Test Mode OFF)
- [ ] Order status updated from webhook, not only from return URL
- [ ] HTTPS enabled on your server (required for callbacks)
- [ ] Handle idempotency — webhook may be delivered more than once; check if order already updated before processing
- [ ] No sensitive data in logs

---

## Available SDKs & Plugins

| Type | Options |
|---|---|
| Libraries | PHP, Java, C#, Node.js (see https://github.com/CHIPAsia) |
| Plugins | WooCommerce, OpenCart, Magento, PrestaShop, WHMCS, Gravity Forms |
| Mobile SDKs | iOS, Android |

If a ready-made SDK exists for the user's language, recommend it over raw HTTP calls.

---

## Common Issues & Fixes

| Problem | Likely Cause | Fix |
|---|---|---|
| `401 Unauthorized` | Wrong or missing API key | Check `Authorization: Bearer` header; confirm Test Mode key is used |
| `400 Bad Request` | Missing required fields | Ensure `brand_id`, `client.email`, `purchase.currency`, and at least one product are present |
| Test script shows no `checkout_url` | Empty `.env` values | Fill in `CHIP_SECRET_KEY` and `CHIP_BRAND_ID` in `.env` |
| Webhook not received | Callback URL not public | Ensure URL is publicly accessible; test with https://webhook.site |
| Signature mismatch | Parsing JSON before verifying | Verify against **raw bytes**, not parsed JSON |
| Duplicate order updates | Webhook retries | Check if order is already marked paid before processing again |

---

## References

- API Docs: https://docs.chip-in.asia/chip-collect/api-reference/purchases/create
- Webhooks Guide: https://blog.chip-in.asia/chip-api-webhooks/
- GitHub (all SDKs & plugins): https://github.com/CHIPAsia
- Merchant Portal: https://portal.chip-in.asia/collect
