require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const { pool, ensureSchema } = require("./db");
const pricing = require("./pricing");
const { passwordMatches, signToken, requireAuth } = require("./auth");

const app = express();

// Behind Railway's edge proxy the socket address is always the proxy's, so
// express-rate-limit would bucket the whole internet into one key. Trust exactly
// one hop. Not `true` (that lets anyone spoof X-Forwarded-For for a fresh
// bucket). Same reasoning as cahyana-api.
app.set("trust proxy", 1);

// CORS: the configured site origin + any localhost port for local dev. Requests
// with no Origin (curl, health checks) are allowed through.
const CORS_ORIGIN = process.env.CORS_ORIGIN || "https://saliamakeup.com";
const PROD_ORIGINS = CORS_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean);
const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/;
function originAllowed(origin) {
  if (!origin) return true;
  if (PROD_ORIGINS.includes(origin)) return true;
  if (LOCAL_ORIGIN_RE.test(origin)) return true;
  return false;
}
app.use(
  cors({
    origin: (origin, cb) =>
      originAllowed(origin) ? cb(null, true) : cb(new Error("Not allowed by CORS")),
  }),
);

app.use(express.json());

// Anti-spam on the public POST. The dashboard routes are token-gated, so only
// /bookings (create) and /auth/login are worth limiting.
const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too_many_requests" },
});
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too_many_requests" },
});

const STATUSES = ["baru", "konfirmasi", "selesai"];

// ---- Health -----------------------------------------------------------------
app.get("/health", (_req, res) => res.json({ ok: true }));

// ---- Auth -------------------------------------------------------------------
// POST /auth/login { password } -> { token }
app.post("/auth/login", loginLimiter, (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: "password_required" });
  let ok;
  try {
    ok = passwordMatches(password);
  } catch (e) {
    return res.status(500).json({ error: "server_misconfigured", detail: e.message });
  }
  if (!ok) return res.status(401).json({ error: "wrong_password" });
  res.json({ token: signToken() });
});

// ---- Bookings ---------------------------------------------------------------

// POST /bookings (public) — create a booking. The client sends the guest's
// choices; the server recomputes service_nama / area_nama / total so the stored
// row never depends on a client-supplied price.
app.post("/bookings", publicLimiter, async (req, res) => {
  const b = req.body || {};
  const missing = ["nama", "telepon", "service_id", "tanggal", "jam"].filter(
    (k) => !b[k] || String(b[k]).trim() === "",
  );
  if (missing.length) return res.status(400).json({ error: "missing_fields", fields: missing });

  const q = pricing.quote({
    service_id: b.service_id,
    area_id: b.area_id,
    hairdo: b.hairdo,
  });
  if (q.error) return res.status(400).json({ error: q.error });

  try {
    const { rows } = await pool.query(
      `INSERT INTO bookings
         (nama, telepon, service_id, service_nama, hairdo,
          area_id, area_nama, tanggal, jam, lokasi, catatan, total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        String(b.nama).trim(),
        String(b.telepon).trim(),
        q.service_id,
        q.service_nama,
        q.hairdo,
        q.area_id,
        q.area_nama,
        b.tanggal,
        b.jam,
        b.lokasi ? String(b.lokasi).trim() : null,
        b.catatan ? String(b.catatan).trim() : null,
        q.total,
      ],
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// GET /bookings (admin) — newest first, optional ?status= filter.
app.get("/bookings", requireAuth, async (req, res) => {
  const { status } = req.query;
  try {
    let rows;
    if (status && STATUSES.includes(status)) {
      ({ rows } = await pool.query(
        "SELECT * FROM bookings WHERE status = $1 ORDER BY created_at DESC, id DESC",
        [status],
      ));
    } else {
      ({ rows } = await pool.query(
        "SELECT * FROM bookings ORDER BY created_at DESC, id DESC",
      ));
    }
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// PATCH /bookings/:id (admin) — update status only.
app.patch("/bookings/:id", requireAuth, async (req, res) => {
  const { status } = req.body || {};
  if (!STATUSES.includes(status)) return res.status(400).json({ error: "invalid_status" });
  try {
    const { rows } = await pool.query(
      "UPDATE bookings SET status = $1 WHERE id = $2 RETURNING *",
      [status, req.params.id],
    );
    if (!rows.length) return res.status(404).json({ error: "not_found" });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// DELETE /bookings/:id (admin)
app.delete("/bookings/:id", requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query("DELETE FROM bookings WHERE id = $1", [
      req.params.id,
    ]);
    if (!rowCount) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// ---- Boot -------------------------------------------------------------------
const PORT = process.env.PORT || 4000;

// Exported for tests: they mount `app` without opening a socket or a DB pool.
module.exports = { app, STATUSES };

if (require.main === module) {
  ensureSchema()
    .then(() => {
      app.listen(PORT, () => console.log(`salia-makeup api listening on :${PORT}`));
    })
    .catch((e) => {
      console.error("Failed to ensure schema:", e.message);
      process.exit(1);
    });
}
