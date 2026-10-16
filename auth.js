import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomBytes, randomUUID } from 'node:crypto';
import { pool, isDbConfigured } from './db.js';

// Falls back to a random per-process secret when JWT_SECRET isn't set so
// the app doesn't silently sign tokens with a well-known/empty secret - but
// this means already-issued tokens become invalid on every restart, so
// JWT_SECRET should always be set explicitly in Railway's env vars for
// production.
const JWT_SECRET = process.env.JWT_SECRET || randomFallbackSecret();
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

function randomFallbackSecret() {
  console.warn('JWT_SECRET is not set - using a random, process-local secret. Set JWT_SECRET in your environment for stable sessions across restarts.');
  // Use a CSPRNG (crypto.randomBytes), not Math.random(), since this value
  // is used to sign authentication tokens.
  return randomBytes(48).toString('hex');
}

const BCRYPT_ROUNDS = 10;

export async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

export async function issueToken(user) {
  const sessionId = randomUUID();
  const token = jwt.sign(
    { sub: user.id, sid: sessionId },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
  // Updating the user's single session slot serializes concurrent logins.
  // Checking the password hash also prevents a login racing a password reset.
  const { rows } = await pool.query(
    `UPDATE users SET active_session_id = $1, session_tab_id = NULL,
       session_tab_expires_at = NULL, last_login_at = now()
     WHERE id = $2 AND password_hash = $3 AND is_active AND NOT blacklisted AND email_verified
     RETURNING id`,
    [sessionId, user.id, user.password_hash]
  );
  if (!rows[0]) throw new Error('Account changed. Please log in again.');
  return token;
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function extractBearerToken(req) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  return token;
}

// Attaches req.user ({ id, email, role }) when a valid bearer token is
// present; always requires a valid, non-expired token - never trusts a
// user id supplied in the request body/query, which is what let one user's
// request resolve another user's data in the first place.
export async function requireSession(req, res, next) {
  res.set('Cache-Control', 'no-store');
  if (!isDbConfigured()) {
    return res.status(503).json({ success: false, error: 'Accounts are not configured on this server (DATABASE_URL missing).' });
  }

  const token = extractBearerToken(req);
  if (!token) {
    return res.status(401).json({ success: false, error: 'Authentication required.' });
  }

  let payload;
  try {
    payload = verifyToken(token);
  } catch (error) {
    return res.status(401).json({ success: false, error: 'Invalid or expired session. Please log in again.' });
  }

  if (typeof payload.sid !== 'string' || typeof payload.sub !== 'string') {
    return res.status(401).json({ success: false, code: 'SESSION_REPLACED', error: 'Please log in again.' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT id, email, role, session_tab_id,
         session_tab_expires_at > now() AS tab_active
       FROM users WHERE id = $1 AND active_session_id = $2
         AND is_active AND NOT blacklisted AND email_verified`,
      [payload.sub, payload.sid]
    );
    const user = rows[0];
    if (!user) {
      return res.status(401).json({ success: false, code: 'SESSION_REPLACED', error: 'Your account was signed in elsewhere or your session was revoked.' });
    }
    req.user = { id: user.id, email: user.email, role: user.role };
    req.sessionId = payload.sid;
    req.sessionTab = { id: user.session_tab_id, active: user.tab_active };
    next();
  } catch (error) {
    console.error('Session validation failed:', error);
    return res.status(503).json({ success: false, error: 'Session validation unavailable. Please try again.' });
  }
}

export function requireAuth(req, res, next) {
  return requireSession(req, res, () => {
    if (!req.sessionTab.active || req.sessionTab.id !== req.headers['x-tab-id']) {
      return res.status(409).json({ success: false, code: 'TAB_CONFLICT', error: 'Already open in another tab. Use this tab instead to continue.' });
    }
    next();
  });
}

export async function claimSessionTab(req, res) {
  const tabId = req.headers['x-tab-id'];
  if (typeof tabId !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(tabId)) {
    return res.status(400).json({ success: false, error: 'A valid tab identifier is required.' });
  }
  const heartbeat = req.path === '/auth/session/heartbeat';
  try {
    const { rows } = await pool.query(
      `UPDATE users SET session_tab_id = $1, session_tab_expires_at = now() + interval '90 seconds'
       WHERE id = $2 AND active_session_id = $3 AND is_active AND NOT blacklisted AND email_verified
         AND (session_tab_id = $1 ${heartbeat ? '' : `OR session_tab_id IS NULL OR session_tab_expires_at <= now() OR $4::boolean`})
       RETURNING id`,
      heartbeat
        ? [tabId, req.user.id, req.sessionId]
        : [tabId, req.user.id, req.sessionId, req.body?.takeover === true]
    );
    if (!rows[0]) {
      return res.status(409).json({ success: false, code: 'TAB_CONFLICT', error: 'Already open in another tab.' });
    }
    return res.json({ success: true });
  } catch (error) {
    console.error('Tab lease update failed:', error);
    return res.status(503).json({ success: false, error: 'Could not update tab session. Please try again.' });
  }
}

export async function logoutSession(req, res) {
  try {
    await pool.query(
      `UPDATE users SET active_session_id = NULL, session_tab_id = NULL, session_tab_expires_at = NULL
       WHERE id = $1 AND active_session_id = $2`,
      [req.user.id, req.sessionId]
    );
    return res.json({ success: true });
  } catch (error) {
    console.error('Session logout failed:', error);
    return res.status(503).json({ success: false, error: 'Could not log out. Please try again.' });
  }
}

export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Admin access required.' });
  }
  next();
}

export async function findUserByEmail(email) {
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
  return rows[0] || null;
}

export async function findUserById(id) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

export async function createUser({ email, passwordHash, role = 'user', displayName = null }) {
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, role, display_name, email_verified)
     VALUES ($1, $2, $3, $4, FALSE)
     RETURNING id, email, role, display_name, created_at`,
    [email.toLowerCase(), passwordHash, role, displayName]
  );
  return rows[0];
}

// Records every login attempt (success or failure) against the submitted
// email - used by the admin dashboard's login-attempts view. Keyed on the
// raw email (not user_id) so attempts against an unregistered/mistyped
// email are still visible, and failures are never silently dropped just
// because this insert itself fails.
export async function recordLoginAttempt({ email, success, reason = null, ip = null, userAgent = null }) {
  try {
    await pool.query(
      `INSERT INTO login_attempts (email, success, reason, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [String(email || '').toLowerCase(), success, reason, ip, userAgent]
    );
  } catch (error) {
    console.error('Failed to record login attempt:', error);
  }
}

export async function markUserLoggedIn(userId) {
  await pool.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [userId]);
}
