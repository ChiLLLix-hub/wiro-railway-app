import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
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
  return [...Array(32)].map(() => Math.random().toString(36)[2]).join('');
}

const BCRYPT_ROUNDS = 10;

export async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

export function issueToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
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
export async function requireAuth(req, res, next) {
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

  req.user = { id: payload.sub, email: payload.email, role: payload.role };
  next();
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
    `INSERT INTO users (email, password_hash, role, display_name)
     VALUES ($1, $2, $3, $4)
     RETURNING id, email, role, display_name, created_at`,
    [email.toLowerCase(), passwordHash, role, displayName]
  );
  return rows[0];
}
