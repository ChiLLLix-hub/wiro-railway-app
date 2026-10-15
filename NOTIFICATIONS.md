# Notifications setup

Optional notifications are off by default. Users manage generation-complete and demo-credit-added notifications in **Dashboard → Notification preferences**. Email verification and password reset messages are account-security emails and are sent independently of those preferences.

## Email

Use the SMTP credentials for a mailbox you own, including one provided by your web host. Add these variables to the Railway service:

- `SMTP_HOST`
- `SMTP_PORT` (usually `587`; use `465` for implicit TLS)
- `SMTP_USER`
- `SMTP_PASSWORD`
- `EMAIL_FROM` (for example, `Mygenx Studio <no-reply@example.com>`)
- `FRONTEND_BASE_URL` (the public cPanel site origin, without a trailing slash)

Configure the sending domain's SPF and DKIM records with the mail host, and add DMARC. Confirm that the host allows SMTP connections from Railway. Verification links expire after 24 hours; password-reset links expire after one hour.

## Telegram

Create a bot with Telegram's BotFather, then set these Railway variables:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_BOT_USERNAME` (without the `@`)
- `TELEGRAM_WEBHOOK_SECRET` (a random secret of 1–256 characters using Telegram's allowed characters)

Set the bot webhook to `https://<your-backend-host>/integrations/telegram/webhook`, using the same secret as Telegram's `secret_token`. Users click **Link bot** in their dashboard, then start the bot from the generated link. The application stores their Telegram chat ID; no phone number is requested or required.

## Discord

Create a Discord application and configure an OAuth2 redirect URI exactly matching:

`https://<your-backend-host>/integrations/discord/callback`

Set these Railway variables:

- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET`
- `DISCORD_REDIRECT_URI` (the exact callback URL above)
- `DISCORD_BOT_TOKEN`

The OAuth flow links the user's Discord account ID. The bot sends individual direct messages; it does not post prompts or generated output links in shared channels. Discord users must allow DMs from the bot (typically by sharing a server with it). No phone number is requested or required.

## Delivery and testing

The database outbox retries failed deliveries with increasing delays and uses unique event/channel keys to avoid duplicate sends. The Railway process checks pending generations in the background, so generation notifications do not depend on the browser remaining open. Demo top-ups remain test credits, not proof of a payment.

After configuring email, sign in with a verified account, then use **Dashboard → Test email delivery** to send a message to that account's email address. The form reports safe SMTP diagnostics, including timeout guidance. It is limited to three tests per 15 minutes per IP. After configuring each other integration, verify its connection with a user account and enable the desired event/channel toggles in the dashboard. Provider failures leave queued messages for retry and are recorded in server logs.
