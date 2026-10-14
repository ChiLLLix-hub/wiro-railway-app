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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS generations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      wiro_task_id TEXT NOT NULL,
      model_slug TEXT,
      prompt TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      total_cost NUMERIC,
      outputs JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ
    );
  `);

  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS generations_wiro_task_id_idx ON generations (wiro_task_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS generations_user_id_idx ON generations (user_id);`);

  // gen_random_uuid() lives in pgcrypto on older Postgres - make sure it's
  // available before the CREATE TABLEs above run.
}

export async function ensurePgCryptoExtension() {
  if (!pool) return;
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
}
