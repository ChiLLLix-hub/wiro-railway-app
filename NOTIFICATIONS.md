# Notifications setup

Optional notifications are off by default. Users manage generation-complete and demo-credit-added notifications in **Dashboard → Notification preferences**. Email verification and password reset messages are account-security emails and are sent independently of those preferences.

## Email

Email is delivered through the Resend HTTP API when `RESEND_API_KEY` is set, otherwise directly over SMTP.

Railway blocks outbound SMTP (ports 25/465/587) on the Free, Trial and Hobby plans; only Pro and above can use SMTP. Resend's API uses HTTPS, so it works on Hobby. The "Resend Starter" Railway template is not required: copy the API key into this app's service as `RESEND_API_KEY` (the template service itself is not called), verify your sending domain in Resend, and set `EMAIL_FROM` to an address on that domain (for example, `Mygenx Studio <no-reply@example.com>`).

Set `FRONTEND_BASE_URL` on this app to the public cPanel site origin, without a trailing slash; account verification and password-reset messages use it in their links.

Use SMTP credentials for a mailbox you own, including one provided by your web host. Set these variables on this app's Railway service:

- `SMTP_HOST`
- `SMTP_PORT` (usually `587`; use `465` for implicit TLS)
- `SMTP_USER`
- `SMTP_PASSWORD`
- `EMAIL_FROM` (for example, `Mygenx Studio <no-reply@example.com>`)

Configure the sending domain's SPF and DKIM records with the mail host, and add DMARC. Confirm that the host allows SMTP connections from Railway. Verification links expire after 24 hours; password-reset links expire after one hour.

## Delivery and testing

The database outbox retries failed deliveries with increasing delays and uses unique event/channel keys to avoid duplicate sends. The Railway process checks pending generations in the background, so generation notifications do not depend on the browser remaining open. Demo top-ups remain test credits, not proof of a payment.

After configuring email, verify its connection with a user account and enable the desired event/channel toggles in the dashboard. Provider failures leave queued messages for retry and are recorded in server logs.

## CHIP payments (Railway variables)

- `CHIP_API_KEY` (required): CHIP secret key.
- `CHIP_BRAND_ID` (required): CHIP brand ID.
- `BACKEND_BASE_URL` (recommended): public Railway URL, used for CHIP's payment callback.
- `FRONTEND_BASE_URL`: site that hosts `payment-success.html` / `payment-failed.html`.
- `CHIP_BASE_URL` (optional): defaults to `https://gate.chip-in.asia/api/v1`.
- `CHIP_SALE_ENDS_AT` (optional ISO date): when the 50→RM45 / 100→RM80 price slash ends; unset = no end. `CHIP_SALE_ENABLED=false` turns it off.
