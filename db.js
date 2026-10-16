import pg from 'pg';

const { Pool } = pg;

// Railway's managed Postgres plugin injects DATABASE_URL automatically when
// a Postgres service is attached to this app - no separate host/port/user
// env vars are needed. SSL is required for Railway's Postgres but its
// certificate isn't in Node's default trust store, so we disable strict
// verification (standard practice for managed DB providers like Railway/
// Heroku) rather than rejecting every connection.
const connectionString = process.env.DATABASE_URL;

export const pool = connectionString
  ? new Pool({
      connectionString,
      ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false }
    })
  : null;

export function isDbConfigured() {
  return Boolean(pool);
}

// Creates the schema if it doesn't already exist. Safe to call on every
// boot - CREATE TABLE/INDEX IF NOT EXISTS make this idempotent, so no
// separate migration runner is required for this app's current size.
export async function initSchema() {
  if (!pool) {
    console.warn('DATABASE_URL is not set - skipping database schema init. Auth/history endpoints will be unavailable.');
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
      display_name TEXT,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      credits NUMERIC NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // CREATE TABLE IF NOT EXISTS above won't add new columns to a users
  // table that already existed before `credits` was introduced, so add it
  // separately (idempotent via IF NOT EXISTS) to cover already-deployed
  // databases.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS credits NUMERIC NOT NULL DEFAULT 0;`);

  // Admin dashboard needs: when a user last signed in, and a way to
  // permanently deny a specific email from ever logging in again
  // ("blacklist", distinct from `is_active` which an admin can freely
  // toggle back on - blacklisting records why, for audit purposes).
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS active_session_id TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS session_tab_id TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS session_tab_expires_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS blacklisted BOOLEAN NOT NULL DEFAULT FALSE;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS blacklist_reason TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT TRUE;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_user_id TEXT;`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_telegram_chat_id_idx ON users (telegram_chat_id) WHERE telegram_chat_id IS NOT NULL;`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_discord_user_id_idx ON users (discord_user_id) WHERE discord_user_id IS NOT NULL;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS account_tokens (
      token_hash TEXT PRIMARY KEY,
      token_prefix TEXT NOT NULL,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL CHECK (purpose IN ('email_verification', 'password_reset')),
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`ALTER TABLE account_tokens ADD COLUMN IF NOT EXISTS token_prefix TEXT;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS account_tokens_lookup_idx ON account_tokens (purpose, token_prefix, expires_at);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS account_tokens_user_id_idx ON account_tokens (user_id);`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS integration_link_tokens (
      token_hash TEXT PRIMARY KEY,
      token_prefix TEXT NOT NULL,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK (provider IN ('telegram', 'discord')),
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`ALTER TABLE integration_link_tokens ADD COLUMN IF NOT EXISTS token_prefix TEXT;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS integration_link_tokens_lookup_idx ON integration_link_tokens (provider, token_prefix, expires_at);`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_notification_preferences (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel TEXT NOT NULL CHECK (channel IN ('email', 'telegram', 'discord')),
      event_type TEXT NOT NULL CHECK (event_type IN ('generation_success', 'demo_credit_added')),
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, channel, event_type)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notification_outbox (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      event_key TEXT NOT NULL,
      channel TEXT NOT NULL CHECK (channel IN ('email', 'telegram', 'discord')),
      event_type TEXT NOT NULL DEFAULT 'account',
      destination TEXT NOT NULL,
      subject TEXT NOT NULL,
      message TEXT NOT NULL,
      link TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent')),
      attempts INTEGER NOT NULL DEFAULT 0,
      locked_at TIMESTAMPTZ,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      sent_at TIMESTAMPTZ,
      UNIQUE (event_key, channel)
    );
  `);
  await pool.query(`ALTER TABLE notification_outbox ADD COLUMN IF NOT EXISTS event_type TEXT NOT NULL DEFAULT 'account';`);
  await pool.query(`ALTER TABLE notification_outbox ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS notification_outbox_pending_idx ON notification_outbox (next_attempt_at) WHERE status = 'pending';`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS generations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      wiro_task_id TEXT NOT NULL,
      model_slug TEXT,
      model_tag TEXT,
      prompt TEXT,
      params JSONB,
      status TEXT NOT NULL DEFAULT 'pending',
      held_amount NUMERIC,
      total_cost NUMERIC,
      outputs JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ
    );
  `);

  // `held_amount` records how many credits were put on hold (escrow) for
  // this generation at submission time - needed to settle (refund/charge
  // the difference against) once the task finishes, even on databases
  // created before this column existed.
  await pool.query(`ALTER TABLE generations ADD COLUMN IF NOT EXISTS held_amount NUMERIC;`);
  await pool.query(`ALTER TABLE generations ADD COLUMN IF NOT EXISTS model_tag TEXT;`);
  await pool.query(`ALTER TABLE generations ADD COLUMN IF NOT EXISTS params JSONB;`);
  await pool.query(`ALTER TABLE generations ADD COLUMN IF NOT EXISTS last_polled_at TIMESTAMPTZ;`);

  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS generations_wiro_task_id_idx ON generations (wiro_task_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS generations_user_id_idx ON generations (user_id);`);

  // Records every admin-initiated credit change (manual add/remove with a
  // reason) and every demo top-up, so the admin dashboard can show a real
  // transaction history instead of only the current balance. Deliberately
  // does NOT log every hold/charge/refund from the generation flow itself
  // (that detail already lives on `generations` via held_amount/total_cost)
  // - this table is specifically the "someone changed a balance outside of
  // a generation" audit trail.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS credit_transactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount NUMERIC NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('admin_adjust', 'topup_demo')),
      reason TEXT,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS credit_transactions_user_id_idx ON credit_transactions (user_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS credit_transactions_created_at_idx ON credit_transactions (created_at);`);

  // Every login attempt (success or failure) against an email, for the
  // admin dashboard's "unsuccessful login attempts" view - keyed on the
  // submitted email rather than user_id since a failed attempt may target
  // an email with no matching account at all.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS login_attempts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT NOT NULL,
      success BOOLEAN NOT NULL,
      reason TEXT,
      ip TEXT,
      user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS login_attempts_created_at_idx ON login_attempts (created_at);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS login_attempts_email_idx ON login_attempts (email);`);

  // gen_random_uuid() lives in pgcrypto on older Postgres - make sure it's
  // available before the CREATE TABLEs above run.
}

export async function ensurePgCryptoExtension() {
  if (!pool) return;
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
}
