// Passwordless email login: a 6-digit code, hashed, short-lived, single-use.
// Same idea as the magic-link token. Codes are never stored in the clear.
const crypto = require("crypto");
const { pool } = require("./db");

const TTL_MIN = 10;

function normalizeEmail(e) {
  return String(e || "").trim().toLowerCase();
}
function looksLikeEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}
function genCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}
function hashCode(email, code) {
  return crypto.createHash("sha256").update(`${email}:${code}`).digest("hex");
}

// Create + store a code for this email. Returns { email, code } — the caller
// emails the code. Invalidates older unused codes for the same email so only the
// newest works.
async function issueCode(emailRaw) {
  const email = normalizeEmail(emailRaw);
  if (!looksLikeEmail(email)) return { error: "invalid_email" };
  await pool.query("UPDATE login_codes SET used_at = NOW() WHERE email = $1 AND used_at IS NULL", [email]);
  const code = genCode();
  await pool.query(
    `INSERT INTO login_codes (email, code_hash, expires_at)
     VALUES ($1,$2, NOW() + ($3 || ' minutes')::interval)`,
    [email, hashCode(email, code), String(TTL_MIN)],
  );
  return { email, code };
}

// Verify + consume. Returns { ok, email } or { ok:false, reason }.
async function verifyCode(emailRaw, codeRaw) {
  const email = normalizeEmail(emailRaw);
  const code = String(codeRaw || "").trim();
  if (!looksLikeEmail(email) || !/^\d{6}$/.test(code)) return { ok: false, reason: "invalid" };
  const { rows } = await pool.query(
    `SELECT * FROM login_codes
     WHERE email = $1 AND code_hash = $2 AND used_at IS NULL AND expires_at > NOW()
     ORDER BY id DESC LIMIT 1`,
    [email, hashCode(email, code)],
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: "wrong_or_expired" };
  await pool.query("UPDATE login_codes SET used_at = NOW() WHERE id = $1", [row.id]);
  return { ok: true, email };
}

module.exports = { TTL_MIN, normalizeEmail, looksLikeEmail, issueCode, verifyCode, hashCode };
