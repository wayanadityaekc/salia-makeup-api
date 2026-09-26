// Single-owner auth. No user table: one shared password (ADMIN_PASSWORD) unlocks
// the dashboard, and a signed JWT (JWT_SECRET) proves it on every admin request.
const jwt = require("jsonwebtoken");

// Single-owner admin on a personal phone: keep them logged in for a long time so
// they don't get logged out and miss notifications. Logout still clears it.
const TOKEN_TTL = "90d";

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET is not set");
  return s;
}

// Constant-time compare so the password check does not leak length/prefix via
// timing. Both sides are hashed first because timingSafeEqual needs equal-length
// buffers.
const crypto = require("crypto");
function passwordMatches(input) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) throw new Error("ADMIN_PASSWORD is not set");
  const a = crypto.createHash("sha256").update(String(input)).digest();
  const b = crypto.createHash("sha256").update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function signToken() {
  return jwt.sign({ role: "owner" }, secret(), { expiresIn: TOKEN_TTL });
}

// Bearer-token middleware for every non-public booking route. On any failure it
// answers 401 so the frontend can kick back to the login gate.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "unauthorized" });
  try {
    req.owner = jwt.verify(token, secret());
    next();
  } catch {
    return res.status(401).json({ error: "unauthorized" });
  }
}

module.exports = { passwordMatches, signToken, requireAuth, TOKEN_TTL };
