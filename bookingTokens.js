// Magic-link booking tokens. The admin approves a date on WhatsApp, generates a
// single-use token bound to that date, and sends the link. The public booking
// form stays locked until a valid token unlocks it; submitting consumes it.
const crypto = require("crypto");
const { pool } = require("./db");

function newToken() {
  return crypto.randomBytes(18).toString("base64url"); // url-safe, ~24 chars
}

// Create a token for an approved date. `days` = how long the link stays valid.
async function createToken({ tanggal, days = 3, label = null }) {
  if (!tanggal || !/^\d{4}-\d{2}-\d{2}$/.test(String(tanggal))) {
    return { error: "invalid_date" };
  }
  const token = newToken();
  const d = Math.min(30, Math.max(1, parseInt(days, 10) || 3));
  const { rows } = await pool.query(
    `INSERT INTO booking_tokens (token, tanggal, label, expires_at)
     VALUES ($1,$2,$3, NOW() + ($4 || ' days')::interval) RETURNING *`,
    [token, tanggal, label, String(d)],
  );
  return { token: rows[0].token, tanggal: rows[0].tanggal, expiresAt: rows[0].expires_at };
}

// Validate without consuming. Returns { valid, reason?, tanggal? }.
async function checkToken(token) {
  if (!token) return { valid: false, reason: "missing" };
  const { rows } = await pool.query("SELECT * FROM booking_tokens WHERE token = $1", [token]);
  const t = rows[0];
  if (!t) return { valid: false, reason: "not_found" };
  if (t.used_at) return { valid: false, reason: "used" };
  if (new Date(t.expires_at).getTime() < Date.now()) return { valid: false, reason: "expired" };
  return { valid: true, tanggal: t.tanggal, expiresAt: t.expires_at };
}

// Atomically consume: marks used_at only if still unused + unexpired. Returns the
// row (with tanggal) when it succeeded, or null when the token was already spent.
async function consumeToken(token) {
  const { rows } = await pool.query(
    `UPDATE booking_tokens SET used_at = NOW()
     WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()
     RETURNING *`,
    [token],
  );
  return rows[0] || null;
}

async function listTokens() {
  const { rows } = await pool.query(
    "SELECT * FROM booking_tokens ORDER BY created_at DESC LIMIT 50",
  );
  return rows;
}

module.exports = { createToken, checkToken, consumeToken, listTokens, newToken };
