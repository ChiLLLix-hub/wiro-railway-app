import nodemailer from 'nodemailer';
import { pool } from './db.js';

const smtpHost = process.env.SMTP_HOST;
const smtpPort = Number(process.env.SMTP_PORT || 587);
const mailTransport = smtpHost && process.env.SMTP_USER && process.env.SMTP_PASSWORD
  ? nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
    })
  : null;

export async function queueMail({ userId, eventKey, to, subject, message, link }) {
  await pool.query(
    `INSERT INTO notification_outbox (user_id, event_key, channel, destination, subject, message, link)
     VALUES ($1, $2, 'email', $3, $4, $5, $6)
     ON CONFLICT (event_key, channel) DO NOTHING`,
    [userId || null, eventKey, to, subject, message, link || null]
  );
}

export async function queueOptInNotifications({ userId, eventKey, eventType, subject, message, link }) {
  await pool.query(
    `INSERT INTO notification_outbox (user_id, event_key, channel, destination, subject, message, link)
     SELECT u.id, $2, p.channel,
       CASE p.channel WHEN 'email' THEN u.email WHEN 'telegram' THEN u.telegram_chat_id ELSE u.discord_user_id END,
       $4, $5, $6
     FROM users u
     JOIN user_notification_preferences p ON p.user_id = u.id AND p.event_type = $3 AND p.enabled
     WHERE u.id = $1
       AND ((p.channel = 'email' AND u.email_verified)
         OR (p.channel = 'telegram' AND u.telegram_chat_id IS NOT NULL)
         OR (p.channel = 'discord' AND u.discord_user_id IS NOT NULL))
     ON CONFLICT (event_key, channel) DO NOTHING`,
    [userId, eventKey, eventType, subject, message, link || null]
  );
}

async function deliver(row) {
  if (row.channel === 'email') {
    if (!mailTransport || !process.env.EMAIL_FROM) {
      throw new Error('Email delivery is not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASSWORD, and EMAIL_FROM.');
    }
    const text = row.link ? `${row.message}\n\n${row.link}` : row.message;
    await mailTransport.sendMail({
      from: process.env.EMAIL_FROM,
      to: row.destination,
      subject: row.subject,
      text
    });
    return;
  }

  if (row.channel === 'telegram') {
    if (!process.env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not configured.');
    const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: row.destination,
        text: row.link ? `${row.message}\n${row.link}` : row.message,
        disable_web_page_preview: true
      })
    });
    if (!response.ok) throw new Error(`Telegram delivery failed (${response.status}).`);
    return;
  }

  if (!process.env.DISCORD_BOT_TOKEN) throw new Error('DISCORD_BOT_TOKEN is not configured.');
  const dmResponse = await fetch('https://discord.com/api/v10/users/@me/channels', {
    method: 'POST',
    headers: {
      Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ recipient_id: row.destination })
  });
  const dm = await dmResponse.json().catch(() => ({}));
  if (!dmResponse.ok || !dm.id) throw new Error(`Discord DM could not be opened (${dmResponse.status}).`);
  const messageResponse = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(dm.id)}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ content: row.link ? `${row.message}\n${row.link}` : row.message })
  });
  if (!messageResponse.ok) throw new Error(`Discord delivery failed (${messageResponse.status}).`);
}

export async function processNotificationOutbox() {
  if (!pool) return;
  const { rows } = await pool.query(
    `UPDATE notification_outbox SET status = 'sending', attempts = attempts + 1
     WHERE id IN (
       SELECT id FROM notification_outbox
       WHERE (status = 'pending' AND next_attempt_at <= now())
          OR (status = 'sending' AND created_at < now() - interval '10 minutes')
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 20
     )
     RETURNING *`
  );

  for (const row of rows) {
    try {
      await deliver(row);
      await pool.query(
        `UPDATE notification_outbox SET status = 'sent', sent_at = now(), last_error = NULL WHERE id = $1`,
        [row.id]
      );
    } catch (error) {
      const delaySeconds = Math.min(3600, 30 * (2 ** Math.min(row.attempts, 7)));
      await pool.query(
        `UPDATE notification_outbox SET status = 'pending', next_attempt_at = now() + ($2 * interval '1 second'),
           last_error = $3 WHERE id = $1`,
        [row.id, delaySeconds, String(error.message || error).slice(0, 1000)]
      );
    }
  }
}

export function frontendBaseUrl() {
  return String(process.env.FRONTEND_BASE_URL || 'https://agromar.com.my').replace(/\/+$/, '');
}
