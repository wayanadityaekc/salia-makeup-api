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
const KINDS = ["makeup", "hairdo", "nail"];

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
      hairdo: rows.filter((r) => r.kind === "hairdo"),
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
      `INSERT INTO services (id, kind, nama, ringkas, deskripsi, detail, info, base, hairdo_included, foto, sort, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        id, b.kind, String(b.nama).trim(), b.ringkas || null,
        b.deskripsi || null, b.detail || null, b.info || null,
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
    deskripsi: b.deskripsi !== undefined ? b.deskripsi : existing.deskripsi,
    detail: b.detail !== undefined ? b.detail : existing.detail,
    info: b.info !== undefined ? b.info : existing.info,
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
         foto=$6, sort=$7, active=$8, deskripsi=$9, detail=$10, info=$11 WHERE id=$12 RETURNING *`,
      [next.kind, next.nama, next.ringkas, next.base, next.hairdo_included, next.foto, next.sort, next.active, next.deskripsi, next.detail, next.info, req.params.id],
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

// ---- Live chat --------------------------------------------------------------
// A guest is identified by a random conversation id they generate and keep in
// localStorage (no guest login). It's unguessable, so it also acts as the read
// key for that one thread. Owner routes are admin-gated.
const CID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const chatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 240, standardHeaders: true, legacyHeaders: false,
  message: { error: "too_many_requests" },
});

function chatMsgRow(r) {
  return { id: r.id, sender: r.sender, body: r.body, createdAt: r.created_at };
}

// POST /chat/:cid/messages (public) — guest sends a message. Creates the
// conversation on first message. Notifies the owner.
app.post("/chat/:cid/messages", chatLimiter, async (req, res) => {
  const cid = req.params.cid;
  if (!CID_RE.test(cid)) return res.status(400).json({ error: "invalid_cid" });
  const b = req.body || {};
  const body = String(b.body || "").trim();
  if (!body) return res.status(400).json({ error: "empty_message" });
  if (body.length > 2000) return res.status(400).json({ error: "message_too_long" });
  const nama = b.nama ? String(b.nama).trim().slice(0, 80) : null;
  const telepon = b.telepon ? String(b.telepon).trim().slice(0, 40) : null;
  try {
    // Upsert conversation; keep the first name/phone unless empty.
    await pool.query(
      `INSERT INTO conversations (id, nama, telepon, last_body, last_sender, last_at, owner_unread)
       VALUES ($1,$2,$3,$4,'guest',NOW(),1)
       ON CONFLICT (id) DO UPDATE SET
         nama = COALESCE(conversations.nama, EXCLUDED.nama),
         telepon = COALESCE(conversations.telepon, EXCLUDED.telepon),
         last_body = EXCLUDED.last_body, last_sender = 'guest', last_at = NOW(),
         owner_unread = conversations.owner_unread + 1`,
      [cid, nama, telepon, body],
    );
    const { rows } = await pool.query(
      "INSERT INTO chat_messages (conversation_id, sender, body) VALUES ($1,'guest',$2) RETURNING *",
      [cid, body],
    );
    const { rows: crows } = await pool.query("SELECT id, nama FROM conversations WHERE id = $1", [cid]);
    push.notifyNewChat(crows[0] || { id: cid, nama }, body); // fire-and-forget
    res.status(201).json({ message: chatMsgRow(rows[0]) });
  } catch (e) {
    res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// GET /chat/:cid/messages?since=<id> (public) — guest polls its own thread.
app.get("/chat/:cid/messages", async (req, res) => {
  const cid = req.params.cid;
  if (!CID_RE.test(cid)) return res.status(400).json({ error: "invalid_cid" });
  const since = parseInt(req.query.since, 10) || 0;
  try {
    const { rows } = await pool.query(
      "SELECT * FROM chat_messages WHERE conversation_id = $1 AND id > $2 ORDER BY id ASC",
      [cid, since],
    );
    res.json({ messages: rows.map(chatMsgRow) });
  } catch (e) {
    res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// GET /chat (admin) — conversation list, newest activity first.
app.get("/chat", requireAuth, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, nama, telepon, last_body, last_sender, last_at, owner_unread FROM conversations ORDER BY last_at DESC",
    );
    res.json(
      rows.map((r) => ({
        id: r.id, nama: r.nama, telepon: r.telepon,
        lastBody: r.last_body, lastSender: r.last_sender, lastAt: r.last_at, ownerUnread: r.owner_unread,
      })),
    );
  } catch (e) {
    res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// GET /chat/:cid (admin) — full thread; clears the owner's unread count.
app.get("/chat/:cid", requireAuth, async (req, res) => {
  const cid = req.params.cid;
  if (!CID_RE.test(cid)) return res.status(400).json({ error: "invalid_cid" });
  try {
    const { rows: crows } = await pool.query("SELECT * FROM conversations WHERE id = $1", [cid]);
    if (!crows.length) return res.status(404).json({ error: "not_found" });
    await pool.query("UPDATE conversations SET owner_unread = 0 WHERE id = $1", [cid]);
    const { rows } = await pool.query(
      "SELECT * FROM chat_messages WHERE conversation_id = $1 ORDER BY id ASC",
      [cid],
    );
    const c = crows[0];
    res.json({
      conversation: { id: c.id, nama: c.nama, telepon: c.telepon },
      messages: rows.map(chatMsgRow),
    });
  } catch (e) {
    res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// POST /chat/:cid/reply (admin) — owner replies. Guest sees it on next poll.
app.post("/chat/:cid/reply", requireAuth, async (req, res) => {
  const cid = req.params.cid;
  if (!CID_RE.test(cid)) return res.status(400).json({ error: "invalid_cid" });
  const body = String((req.body || {}).body || "").trim();
  if (!body) return res.status(400).json({ error: "empty_message" });
  if (body.length > 2000) return res.status(400).json({ error: "message_too_long" });
  try {
    const { rowCount } = await pool.query("SELECT 1 FROM conversations WHERE id = $1", [cid]);
    if (!rowCount) return res.status(404).json({ error: "not_found" });
    const { rows } = await pool.query(
      "INSERT INTO chat_messages (conversation_id, sender, body) VALUES ($1,'owner',$2) RETURNING *",
      [cid, body],
    );
    await pool.query(
      "UPDATE conversations SET last_body=$1, last_sender='owner', last_at=NOW() WHERE id=$2",
      [body, cid],
    );
    res.status(201).json({ message: chatMsgRow(rows[0]) });
  } catch (e) {
    res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// DELETE /chat/:cid (admin)
app.delete("/chat/:cid", requireAuth, async (req, res) => {
  const cid = req.params.cid;
  try {
    await pool.query("DELETE FROM chat_messages WHERE conversation_id = $1", [cid]);
    const { rowCount } = await pool.query("DELETE FROM conversations WHERE id = $1", [cid]);
    if (!rowCount) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "db_error", detail: e.message });
  }
});

// ---- Bookings ---------------------------------------------------------------
// POST /bookings (public). The total is recomputed from the DB service rows — a
// client-sent total is never trusted, and prices follow whatever the owner set in
// the dashboard.
//
// Two shapes, both supported:
//   - CART (new checkout): { items: [id,...], orang, ... } — up to one item per
//     category; total = sum(item.base) × orang + ongkir (once). `jam` = ready time.
//   - SINGLE (legacy): { service_id, hairdo, ... }.
app.post("/bookings", publicLimiter, async (req, res) => {
  const b = req.body || {};
  const baseMissing = ["nama", "telepon", "tanggal", "jam"].filter(
    (k) => !b[k] || String(b[k]).trim() === "",
  );
  if (baseMissing.length) return res.status(400).json({ error: "missing_fields", fields: baseMissing });

  let areaList;
  try {
    areaList = (await settings.getSettings()).areas;
  } catch {
    areaList = null; // fall back to default areas
  }

  const isCart = Array.isArray(b.items) && b.items.length > 0;
  let ins; // { service_id, service_nama, hairdo, area_id, area_nama, total, items, orang }

  try {
    if (isCart) {
      const ids = [...new Set(b.items.map((x) => String(x)))].slice(0, 3);
      const rows = [];
      for (const id of ids) {
        const svc = await getService(id);
        if (!svc || !svc.active) return res.status(400).json({ error: "unknown_service", id });
        rows.push(svc);
      }
      const q = pricing.computeCart({ items: rows, orang: b.orang, area_id: b.area_id, areaList });
      if (q.error) return res.status(400).json({ error: q.error });
      ins = {
        service_id: q.items[0].id,
        service_nama: q.items.map((i) => i.nama).join(", "),
        hairdo: false,
        area_id: q.area_id,
        area_nama: q.area_nama,
        total: q.total,
        items: JSON.stringify(q.items),
        orang: q.orang,
      };
    } else {
      if (!b.service_id || String(b.service_id).trim() === "")
        return res.status(400).json({ error: "missing_fields", fields: ["service_id"] });
      const service = await getService(b.service_id);
      if (!service || !service.active) return res.status(400).json({ error: "unknown_service" });
      const q = pricing.computeTotal({ service, area_id: b.area_id, hairdo: b.hairdo, areaList });
      if (q.error) return res.status(400).json({ error: q.error });
      ins = { ...q, items: null, orang: 1 };
    }
  } catch (e) {
    return res.status(500).json({ error: "db_error", detail: e.message });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO bookings
         (nama, telepon, service_id, service_nama, hairdo,
          area_id, area_nama, tanggal, jam, lokasi, catatan, total, items, orang, instagram)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        String(b.nama).trim(), String(b.telepon).trim(),
        ins.service_id, ins.service_nama, ins.hairdo,
        ins.area_id, ins.area_nama, b.tanggal, b.jam,
        b.lokasi ? String(b.lokasi).trim() : null,
        b.catatan ? String(b.catatan).trim() : null,
        ins.total, ins.items, ins.orang,
        b.instagram ? String(b.instagram).trim().replace(/^@/, "") : null,
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
