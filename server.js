require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const multer = require("multer");

const { pool, ensureSchema } = require("./db");
const pricing = require("./pricing");
const uploads = require("./uploads");
const settings = require("./settings");
const push = require("./push");
const { passwordMatches, signToken, requireAuth } = require("./auth");

const app = express();

// Behind Railway's edge proxy the socket address is always the proxy's, so
// express-rate-limit would bucket the whole internet into one key. Trust exactly
// one hop. Not `true` (that lets anyone spoof X-Forwarded-For). Same as cahyana-api.
app.set("trust proxy", 1);

// CORS: the configured site origin(s) + any localhost port. No-Origin requests
// (curl, health checks) are allowed through.
const CORS_ORIGIN = process.env.CORS_ORIGIN || "https://saliamakeup.com";
const PROD_ORIGINS = CORS_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean);
const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/;
// Vercel gives every deploy its own *.vercel.app URL, so it can't be listed
// ahead of time. Enable while testing on Vercel; turn off once the real domain
// (saliamakeup.com) is pointed there — it admits any Vercel-hosted page.
const VERCEL_ORIGIN_RE = /^https:\/\/[a-z0-9][a-z0-9-]*\.vercel\.app$/;
const ALLOW_VERCEL = process.env.ALLOW_VERCEL_PREVIEWS === "true";
function originAllowed(origin) {
  if (!origin) return true;
  if (PROD_ORIGINS.includes(origin)) return true;
  if (LOCAL_ORIGIN_RE.test(origin)) return true;
  if (ALLOW_VERCEL && VERCEL_ORIGIN_RE.test(origin)) return true;
  return false;
}
app.use(
  cors({
    origin: (origin, cb) =>
      originAllowed(origin) ? cb(null, true) : cb(new Error("Not allowed by CORS")),
  }),
);

app.use(express.json());

// Multipart for image uploads. Memory storage — we forward the buffer to
// Cloudinary and never write to disk. 8 MB cap covers a phone photo.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: "too_many_requests" },
});
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: "too_many_requests" },
});

const STATUSES = ["baru", "konfirmasi", "selesai"];
const KINDS = ["makeup", "nail"];

// ---- Health -----------------------------------------------------------------
app.get("/health", (_req, res) => res.json({ ok: true }));

// ---- Settings ---------------------------------------------------------------
// GET /settings (public) — DP %, bank account, area fees (ongkir), social links.
// All of this is meant to be shown on the site, so no auth on the read.
app.get("/settings", async (_req, res) => {
  try {
    res.json(await settings.getSettings());
  } catch (e) {
    res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// PATCH /settings (admin)
app.patch("/settings", requireAuth, async (req, res) => {
  try {
    res.json(await settings.updateSettings(req.body || {}));
  } catch (e) {
    res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// ---- Push notifications ------------------------------------------------------
// GET /push/public-key (public) — the VAPID public key the browser needs to
// subscribe. The private key never leaves the server.
app.get("/push/public-key", async (_req, res) => {
  try {
    res.json({ publicKey: await push.getPublicKey() });
  } catch (e) {
    res.status(500).json({ error: "push_error", detail: e.message });
  }
});

// POST /push/subscribe (admin) — store the owner's browser subscription.
app.post("/push/subscribe", requireAuth, async (req, res) => {
  try {
    await push.subscribe(req.body || {});
    res.status(201).json({ ok: true });
  } catch (e) {
    if (e.code === "invalid_subscription") return res.status(400).json({ error: "invalid_subscription" });
    res.status(500).json({ error: "push_error", detail: e.message });
  }
});

// POST /push/unsubscribe (admin)
app.post("/push/unsubscribe", requireAuth, async (req, res) => {
  try {
    await push.unsubscribe((req.body || {}).endpoint);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "push_error", detail: e.message });
  }
});

// ---- Auth -------------------------------------------------------------------
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

// ---- Services ---------------------------------------------------------------
// GET /services (public) — everything the frontend needs to render + price:
// active services grouped by kind, plus the fixed areas + hairdo add-on.
app.get("/services", async (req, res) => {
  const all = req.query.all === "1"; // admin passes ?all=1 to see inactive too
  try {
    const { rows } = await pool.query(
      `SELECT * FROM services ${all ? "" : "WHERE active = TRUE"} ORDER BY kind, sort, nama`,
    );
    const s = await settings.getSettings();
    res.json({
      services: rows.filter((r) => r.kind === "makeup"),
      nailArt: rows.filter((r) => r.kind === "nail"),
      areas: s.areas, // owner-set ongkir
      hairdoAddon: pricing.hairdoAddon,
      dpPercent: s.dpPercent,
    });
  } catch (e) {
    res.status(500).json({ error: "db_error", detail: e.message });
  }
});

async function getService(id) {
  const { rows } = await pool.query("SELECT * FROM services WHERE id = $1", [id]);
  return rows[0] || null;
}

// Slugify a name into an id when the owner doesn't supply one.
function slugify(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// POST /services (admin) — create.
app.post("/services", requireAuth, async (req, res) => {
  const b = req.body || {};
  if (!b.nama || !b.kind) return res.status(400).json({ error: "missing_fields", fields: ["nama", "kind"] });
  if (!KINDS.includes(b.kind)) return res.status(400).json({ error: "invalid_kind" });
  const id = (b.id && slugify(b.id)) || slugify(b.nama);
  if (!id) return res.status(400).json({ error: "invalid_id" });
  // nail art never carries the hairdo flag; makeup defaults to false (add-on offered).
  const hairdoIncluded = b.kind === "nail" ? null : b.hairdo_included === true;
  try {
    const { rows } = await pool.query(
      `INSERT INTO services (id, kind, nama, ringkas, base, hairdo_included, foto, sort, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        id, b.kind, String(b.nama).trim(), b.ringkas || null,
        Math.max(0, parseInt(b.base, 10) || 0), hairdoIncluded,
        b.foto || null, parseInt(b.sort, 10) || 0,
        b.active === undefined ? true : !!b.active,
      ],
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "id_exists" });
    res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// PATCH /services/:id (admin) — update any subset of fields.
app.patch("/services/:id", requireAuth, async (req, res) => {
  const b = req.body || {};
  const existing = await getService(req.params.id).catch(() => null);
  if (!existing) return res.status(404).json({ error: "not_found" });

  const kind = b.kind && KINDS.includes(b.kind) ? b.kind : existing.kind;
  const next = {
    kind,
    nama: b.nama !== undefined ? String(b.nama).trim() : existing.nama,
    ringkas: b.ringkas !== undefined ? b.ringkas : existing.ringkas,
    base: b.base !== undefined ? Math.max(0, parseInt(b.base, 10) || 0) : existing.base,
    // nail art forces null; makeup keeps/accepts a boolean.
    hairdo_included:
      kind === "nail" ? null : b.hairdo_included !== undefined ? !!b.hairdo_included : existing.hairdo_included,
    foto: b.foto !== undefined ? b.foto : existing.foto,
    sort: b.sort !== undefined ? parseInt(b.sort, 10) || 0 : existing.sort,
    active: b.active !== undefined ? !!b.active : existing.active,
  };
  try {
    const { rows } = await pool.query(
      `UPDATE services SET kind=$1, nama=$2, ringkas=$3, base=$4, hairdo_included=$5,
         foto=$6, sort=$7, active=$8 WHERE id=$9 RETURNING *`,
      [next.kind, next.nama, next.ringkas, next.base, next.hairdo_included, next.foto, next.sort, next.active, req.params.id],
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// DELETE /services/:id (admin)
app.delete("/services/:id", requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query("DELETE FROM services WHERE id = $1", [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// ---- Gallery ----------------------------------------------------------------
app.get("/gallery", async (_req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM gallery ORDER BY sort, id DESC");
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "db_error", detail: e.message });
  }
});

app.post("/gallery", requireAuth, async (req, res) => {
  const b = req.body || {};
  if (!b.url) return res.status(400).json({ error: "missing_fields", fields: ["url"] });
  try {
    const { rows } = await pool.query(
      "INSERT INTO gallery (url, caption, sort) VALUES ($1,$2,$3) RETURNING *",
      [b.url, b.caption || null, parseInt(b.sort, 10) || 0],
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: "db_error", detail: e.message });
  }
});

app.delete("/gallery/:id", requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query("DELETE FROM gallery WHERE id = $1", [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// ---- Uploads ----------------------------------------------------------------
// POST /uploads (admin, multipart field "file") -> { url }
app.post("/uploads", requireAuth, upload.single("file"), async (req, res) => {
  if (!uploads.isConfigured())
    return res.status(501).json({ error: "uploads_not_configured", detail: "Set CLOUDINARY_* env vars." });
  if (!req.file) return res.status(400).json({ error: "no_file" });
  try {
    const url = await uploads.uploadBuffer(req.file.buffer);
    res.status(201).json({ url });
  } catch (e) {
    res.status(500).json({ error: "upload_failed", detail: e.message });
  }
});

// POST /uploads/proof (public, rate-limited) -> { url }
// Transfer-proof upload for the booking flow. Public because the guest isn't
// logged in; rate-limited + image-only + size-capped to limit abuse. Stored in
// a separate Cloudinary folder from the owner's photos.
app.post("/uploads/proof", publicLimiter, upload.single("file"), async (req, res) => {
  if (!uploads.isConfigured())
    return res.status(501).json({ error: "uploads_not_configured", detail: "Set CLOUDINARY_* env vars." });
  if (!req.file) return res.status(400).json({ error: "no_file" });
  try {
    const url = await uploads.uploadBuffer(req.file.buffer, { folder: "salia/bukti" });
    res.status(201).json({ url });
  } catch (e) {
    res.status(500).json({ error: "upload_failed", detail: e.message });
  }
});

// ---- Bookings ---------------------------------------------------------------
// POST /bookings (public). The total is recomputed from the DB service row — a
// client-sent total is never trusted, and the price follows whatever the owner
// set in the dashboard.
app.post("/bookings", publicLimiter, async (req, res) => {
  const b = req.body || {};
  const missing = ["nama", "telepon", "service_id", "tanggal", "jam"].filter(
    (k) => !b[k] || String(b[k]).trim() === "",
  );
  if (missing.length) return res.status(400).json({ error: "missing_fields", fields: missing });

  let service;
  try {
    service = await getService(b.service_id);
  } catch (e) {
    return res.status(500).json({ error: "db_error", detail: e.message });
  }
  if (!service || !service.active) return res.status(400).json({ error: "unknown_service" });

  let areaList;
  try {
    areaList = (await settings.getSettings()).areas;
  } catch {
    areaList = null; // fall back to default areas in computeTotal
  }
  const q = pricing.computeTotal({ service, area_id: b.area_id, hairdo: b.hairdo, areaList });
  if (q.error) return res.status(400).json({ error: q.error });

  try {
    const { rows } = await pool.query(
      `INSERT INTO bookings
         (nama, telepon, service_id, service_nama, hairdo,
          area_id, area_nama, tanggal, jam, lokasi, catatan, total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        String(b.nama).trim(), String(b.telepon).trim(),
        q.service_id, q.service_nama, q.hairdo,
        q.area_id, q.area_nama, b.tanggal, b.jam,
        b.lokasi ? String(b.lokasi).trim() : null,
        b.catatan ? String(b.catatan).trim() : null,
        q.total,
      ],
    );
    // Notify the owner's installed app. Fire-and-forget — never blocks/fails the booking.
    push.notifyNewBooking(rows[0]);
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// GET /bookings (admin) — newest first, optional ?status=
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
      ({ rows } = await pool.query("SELECT * FROM bookings ORDER BY created_at DESC, id DESC"));
    }
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "db_error", detail: e.message });
  }
});

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

app.delete("/bookings/:id", requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query("DELETE FROM bookings WHERE id = $1", [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// ---- Boot -------------------------------------------------------------------
const PORT = process.env.PORT || 4000;
module.exports = { app, STATUSES, KINDS };

if (require.main === module) {
  ensureSchema()
    .then(() => push.ensurePushSchema())
    .then(() => app.listen(PORT, () => console.log(`salia-makeup api listening on :${PORT}`)))
    .catch((e) => {
      console.error("Failed to ensure schema:", e.message);
      process.exit(1);
    });
}
