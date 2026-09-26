// Customer accounts (separate from the single-owner admin auth in auth.js).
// Password hashing uses Node's built-in scrypt (no extra dependency). User JWTs
// carry role:"user" so they can never pass the admin requireAuth gate.
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const TOKEN_TTL = "90d";

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET is not set");
  return s;
}

// scrypt hash, stored as "scrypt$<saltHex>$<hashHex>".
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, saltHex, hashHex] = String(stored).split("$");
    if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
    const hash = crypto.scryptSync(String(password), Buffer.from(saltHex, "hex"), 64);
    const want = Buffer.from(hashHex, "hex");
    return hash.length === want.length && crypto.timingSafeEqual(hash, want);
  } catch {
    return false;
  }
}

function signUserToken(user) {
  return jwt.sign(
    { role: "user", uid: user.id, cid: user.chat_cid, nama: user.nama },
    secret(),
    { expiresIn: TOKEN_TTL },
  );
}

// Bearer middleware for customer-only routes. 401 on any failure or if the token
// is an admin token (role !== "user").
function requireUser(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "unauthorized" });
  try {
    const payload = jwt.verify(token, secret());
    if (payload.role !== "user") return res.status(401).json({ error: "unauthorized" });
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: "unauthorized" });
  }
}

module.exports = { TOKEN_TTL, hashPassword, verifyPassword, signUserToken, requireUser };
