import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';

test('single-session authentication and tab leases', {
  skip: !process.env.TEST_DATABASE_URL
}, async () => {
  // Use only an explicitly supplied, disposable database.
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.JWT_SECRET = randomUUID();
  const { pool, initSchema, ensurePgCryptoExtension } = await import('./db.js');
  const { issueToken, requireAuth, requireSession, claimSessionTab, logoutSession } = await import('./auth.js');
  await ensurePgCryptoExtension();
  await initSchema();
  const userId = randomUUID();
  const tabA = randomUUID();
  const tabB = randomUUID();
  const { rows: [user] } = await pool.query(
    `INSERT INTO users (id, email, password_hash, email_verified)
     VALUES ($1, $2, 'test-only-hash', TRUE) RETURNING *`,
    [userId, `${userId}@example.invalid`]
  );
  const app = express();
  app.use(express.json());
  app.post('/auth/session/claim', requireSession, claimSessionTab);
  app.post('/auth/session/heartbeat', requireSession, claimSessionTab);
  app.post('/auth/logout', requireSession, logoutSession);
  app.get('/protected', requireAuth, (req, res) => res.json({ role: req.user.role }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const request = (token, path, tab = tabA, body) => fetch(
    `http://127.0.0.1:${server.address().port}${path}`, {
      method: path === '/protected' ? 'GET' : 'POST',
      headers: { Authorization: 'Bear' + 'er ' + token, 'X-Tab-Id': tab, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {})
    }
  );
  try {
    assert.equal((await request('', '/protected')).status, 401);
    const legacy = jwt.sign({ sub: userId }, process.env.JWT_SECRET);
    assert.equal((await request(legacy, '/protected')).status, 401);
    const expired = jwt.sign({ sub: userId, sid: randomUUID() }, process.env.JWT_SECRET, { expiresIn: -1 });
    assert.equal((await request(expired, '/protected')).status, 401);
    const first = await issueToken(user);
    assert.equal((await request(first, '/protected')).status, 409);
    assert.equal((await request(first, '/auth/session/claim')).status, 200);
    assert.equal((await request(first, '/protected')).status, 200);
    assert.equal((await request(first, '/protected', tabB)).status, 409);
    assert.equal((await request(first, '/auth/session/claim', tabB)).status, 409);
    assert.equal((await request(first, '/auth/session/claim', tabB, { takeover: 'true' })).status, 409);
    assert.equal((await request(first, '/auth/session/claim', tabB, { takeover: true })).status, 200);
    assert.equal((await request(first, '/auth/session/heartbeat', tabA)).status, 409);
    assert.equal((await request(first, '/protected', tabB)).status, 200);
    await pool.query(`UPDATE users SET session_tab_expires_at = now() - interval '1 second' WHERE id = $1`, [userId]);
    assert.equal((await request(first, '/protected', tabB)).status, 409);
    assert.equal((await request(first, '/auth/session/claim', tabA)).status, 200);
    const second = await issueToken(user);
    const replaced = await request(first, '/protected');
    assert.equal(replaced.status, 401);
    assert.equal((await replaced.json()).code, 'SESSION_REPLACED');
    // A stale logout must never revoke a newer login.
    assert.equal((await request(first, '/auth/logout')).status, 401);
    assert.equal((await request(second, '/auth/session/claim')).status, 200);
    assert.equal((await request(second, '/protected')).status, 200);
    assert.equal((await request(second, '/auth/logout')).status, 200);
    assert.equal((await request(second, '/protected')).status, 401);

    const concurrent = await Promise.all([issueToken(user), issueToken(user)]);
    const claims = await Promise.all(concurrent.map(token => request(token, '/auth/session/claim')));
    assert.deepEqual(claims.map(result => result.status).sort(), [200, 401]);
    const current = concurrent[claims.findIndex(result => result.status === 200)];
    await pool.query('UPDATE users SET session_tab_id = NULL, session_tab_expires_at = NULL WHERE id = $1', [userId]);
    const competingTabs = await Promise.all([
      request(current, '/auth/session/claim', tabA),
      request(current, '/auth/session/claim', tabB)
    ]);
    assert.deepEqual(competingTabs.map(result => result.status).sort(), [200, 409]);
    assert.equal((await request(current, '/auth/session/claim', 'invalid')).status, 400);
    assert.equal((await request(current, '/auth/session/claim', tabA, { takeover: true })).status, 200);
    await pool.query('UPDATE users SET role = $1 WHERE id = $2', ['admin', userId]);
    assert.equal((await (await request(current, '/protected')).json()).role, 'admin');
    await pool.query('UPDATE users SET is_active = FALSE WHERE id = $1', [userId]);
    assert.equal((await request(current, '/protected')).status, 401);
    await assert.rejects(issueToken(user));
    await pool.query(`UPDATE users SET is_active = TRUE, password_hash = 'changed' WHERE id = $1`, [userId]);
    await assert.rejects(issueToken(user));
    await pool.query('UPDATE users SET blacklisted = TRUE WHERE id = $1', [userId]);
    assert.equal((await request(current, '/protected')).status, 401);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await pool.end();
  }
});
