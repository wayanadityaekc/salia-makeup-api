#!/usr/bin/env node
// Drives the real Express app over HTTP against an in-memory stand-in for
// Postgres (no DB, no network, no Cloudinary). Covers bookings, the services
// CRUD, and the gallery. Adapted from cahyana-api's inquiry-flow-test.
const http = require("http");

process.env.JWT_SECRET = "test-secret";
process.env.ADMIN_PASSWORD = "hunter2";
process.env.CORS_ORIGIN = "https://saliamakeup.com";

const pricing = require("../pricing");
const db = require("../db");

// --- In-memory tables --------------------------------------------------------
let bookingSeq = 0;
let gallerySeq = 0;
const bookings = [];
const gallery = [];
// Seed services exactly like a real first boot.
const services = pricing.SEED_SERVICES.map((s) => ({
  id: s.id, kind: s.kind, nama: s.nama, ringkas: s.ringkas, base: s.base,
  hairdo_included: s.hairdo_included, foto: null, sort: s.sort, active: true,
  created_at: new Date().toISOString(),
}));

// settings singleton
let settingsRow = {
  id: 1, dp_percent: 50, bank_name: null, bank_number: null, bank_holder: null,
  areas: pricing.areas, instagram_url: null, tiktok_url: null, google_url: null, whatsapp: null,
};

db.ensureSchema = async () => {};
db.pool.query = async (text, params = []) => {
  const sql = text.replace(/\s+/g, " ").trim();

  // settings
  if (sql.startsWith("SELECT * FROM settings")) return { rows: [settingsRow], rowCount: 1 };
  if (sql.startsWith("INSERT INTO settings")) return { rows: [settingsRow], rowCount: 1 };
  if (sql.startsWith("UPDATE settings SET")) {
    const [dp, bn, bnum, bh, areasJson, ig, tt, gg, wa] = params;
    settingsRow = {
      ...settingsRow, dp_percent: dp, bank_name: bn, bank_number: bnum, bank_holder: bh,
      areas: JSON.parse(areasJson), instagram_url: ig, tiktok_url: tt, google_url: gg, whatsapp: wa,
    };
    return { rows: [settingsRow], rowCount: 1 };
  }

  // services
  if (sql.startsWith("SELECT * FROM services WHERE id")) {
    const r = services.find((s) => s.id === params[0]);
    return { rows: r ? [r] : [], rowCount: r ? 1 : 0 };
  }
  if (sql.startsWith("SELECT * FROM services")) {
    const onlyActive = sql.includes("WHERE active = TRUE");
    const rows = services
      .filter((s) => (onlyActive ? s.active : true))
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.sort - b.sort);
    return { rows, rowCount: rows.length };
  }
  if (sql.startsWith("INSERT INTO services")) {
    const [id, kind, nama, ringkas, base, hairdo_included, foto, sort, active] = params;
    if (services.some((s) => s.id === id)) { const e = new Error("dup"); e.code = "23505"; throw e; }
    const row = { id, kind, nama, ringkas, base, hairdo_included, foto, sort, active, created_at: new Date().toISOString() };
    services.push(row);
    return { rows: [row], rowCount: 1 };
  }
  if (sql.startsWith("UPDATE services SET")) {
    const [kind, nama, ringkas, base, hairdo_included, foto, sort, active, id] = params;
    const r = services.find((s) => s.id === id);
    if (!r) return { rows: [], rowCount: 0 };
    Object.assign(r, { kind, nama, ringkas, base, hairdo_included, foto, sort, active });
    return { rows: [r], rowCount: 1 };
  }
  if (sql.startsWith("DELETE FROM services")) {
    const i = services.findIndex((s) => s.id === params[0]);
    if (i === -1) return { rows: [], rowCount: 0 };
    services.splice(i, 1);
    return { rows: [], rowCount: 1 };
  }

  // gallery
  if (sql.startsWith("SELECT * FROM gallery")) {
    return { rows: [...gallery].sort((a, b) => a.sort - b.sort || b.id - a.id), rowCount: gallery.length };
  }
  if (sql.startsWith("INSERT INTO gallery")) {
    const [url, caption, sort] = params;
    const row = { id: ++gallerySeq, url, caption, sort, created_at: new Date().toISOString() };
    gallery.push(row);
    return { rows: [row], rowCount: 1 };
  }
  if (sql.startsWith("DELETE FROM gallery")) {
    const i = gallery.findIndex((g) => String(g.id) === String(params[0]));
    if (i === -1) return { rows: [], rowCount: 0 };
    gallery.splice(i, 1);
    return { rows: [], rowCount: 1 };
  }

  // bookings
  if (sql.startsWith("INSERT INTO bookings")) {
    const [nama, telepon, service_id, service_nama, hairdo, area_id, area_nama, tanggal, jam, lokasi, catatan, total] = params;
    const row = {
      id: ++bookingSeq, nama, telepon, service_id, service_nama, hairdo,
      area_id, area_nama, tanggal, jam, lokasi, catatan, total,
      status: "baru", created_at: new Date().toISOString(),
    };
    bookings.push(row);
    return { rows: [row], rowCount: 1 };
  }
  if (sql.startsWith("SELECT * FROM bookings WHERE status")) {
    const rows = bookings.filter((r) => r.status === params[0]).reverse();
    return { rows, rowCount: rows.length };
  }
  if (sql.startsWith("SELECT * FROM bookings")) {
    return { rows: [...bookings].reverse(), rowCount: bookings.length };
  }
  if (sql.startsWith("UPDATE bookings SET status")) {
    const r = bookings.find((x) => String(x.id) === String(params[1]));
    if (!r) return { rows: [], rowCount: 0 };
    r.status = params[0];
    return { rows: [r], rowCount: 1 };
  }
  if (sql.startsWith("DELETE FROM bookings")) {
    const i = bookings.findIndex((x) => String(x.id) === String(params[0]));
    if (i === -1) return { rows: [], rowCount: 0 };
    bookings.splice(i, 1);
    return { rows: [], rowCount: 1 };
  }
  throw new Error("unexpected query in test: " + sql);
};

const { app } = require("../server");

let pass = 0;
const fail = [];
const ok = (label, cond) => (cond ? pass++ : fail.push(label));

async function main() {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = async (method, path, { body, token } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };

  ok("health ok", (await req("GET", "/health")).json?.ok === true);

  // public services list
  const svcList = await req("GET", "/services");
  ok("services grouped", Array.isArray(svcList.json?.services) && Array.isArray(svcList.json?.nailArt));
  ok("services has areas + addon", Array.isArray(svcList.json?.areas) && typeof svcList.json?.hairdoAddon === "number");
  ok("makeup seeded", svcList.json.services.some((s) => s.id === "makeup"));

  // login
  ok("wrong password -> 401", (await req("POST", "/auth/login", { body: { password: "nope" } })).status === 401);
  const token = (await req("POST", "/auth/login", { body: { password: "hunter2" } })).json.token;
  ok("login -> token", typeof token === "string" && token.length > 10);

  // services CRUD (admin)
  ok("create service needs auth", (await req("POST", "/services", { body: { nama: "X", kind: "makeup" } })).status === 401);
  const created = await req("POST", "/services", { token, body: { nama: "Prewedding", kind: "makeup", base: 750000, ringkas: "Paket foto prewedding." } });
  ok("create service -> 201", created.status === 201);
  ok("id slugified from nama", created.json?.id === "prewedding");
  ok("makeup default hairdo_included false", created.json?.hairdo_included === false);
  const edited = await req("PATCH", "/services/prewedding", { token, body: { base: 800000, foto: "https://x/y.jpg" } });
  ok("edit service base", edited.json?.base === 800000);
  ok("edit service foto", edited.json?.foto === "https://x/y.jpg");
  ok("makeup keeps add-on eligible after edit", edited.json?.hairdo_included === false);
  ok("nail kind forces null hairdo", (await req("PATCH", "/services/nail-gel", { token, body: { hairdo_included: true } })).json?.hairdo_included === null);
  ok("invalid kind -> 400", (await req("POST", "/services", { token, body: { nama: "Z", kind: "wat" } })).status === 400);
  ok("duplicate id -> 409", (await req("POST", "/services", { token, body: { id: "makeup", nama: "dup", kind: "makeup" } })).status === 409);

  // booking uses the DB price (edited service)
  const bk = await req("POST", "/bookings", {
    body: { nama: "Ayu", telepon: "08123", service_id: "prewedding", area_id: "luar-jauh", hairdo: true, tanggal: "2026-10-01", jam: "10:00", total: 999999 },
  });
  ok("booking uses DB price", bk.json?.total === 800000 + 100000 + 100000); // base 800k + far 100k + hairdo 100k
  ok("booking ignores client total", bk.json?.total !== 999999);
  ok("unknown service -> 400", (await req("POST", "/bookings", { body: { nama: "A", telepon: "08", service_id: "ghost", tanggal: "2026-10-01", jam: "10:00" } })).status === 400);

  // inactive service can't be booked
  await req("PATCH", "/services/prewedding", { token, body: { active: false } });
  ok("inactive service -> 400", (await req("POST", "/bookings", { body: { nama: "A", telepon: "08", service_id: "prewedding", tanggal: "2026-10-01", jam: "10:00" } })).status === 400);
  ok("inactive hidden from public list", !(await req("GET", "/services")).json.services.some((s) => s.id === "prewedding"));
  ok("inactive shown with ?all=1", (await req("GET", "/services?all=1", { token })).json.services.some((s) => s.id === "prewedding"));

  // delete service
  ok("delete service -> ok", (await req("DELETE", "/services/prewedding", { token })).json?.ok === true);
  ok("delete missing -> 404", (await req("DELETE", "/services/prewedding", { token })).status === 404);

  // gallery
  ok("gallery needs auth", (await req("POST", "/gallery", { body: { url: "x" } })).status === 401);
  const g = await req("POST", "/gallery", { token, body: { url: "https://x/1.jpg", caption: "Look 1" } });
  ok("gallery create -> 201", g.status === 201);
  ok("gallery lists", (await req("GET", "/gallery")).json.length === 1);
  ok("gallery delete", (await req("DELETE", "/gallery/" + g.json.id, { token })).json?.ok === true);
  ok("gallery empty after delete", (await req("GET", "/gallery")).json.length === 0);

  // uploads without Cloudinary -> 501 (not a silent no-op)
  ok("uploads unconfigured -> 501/400", [501, 400].includes((await req("POST", "/uploads", { token })).status));

  // settings
  const st = await req("GET", "/settings");
  ok("settings public read", st.json?.dpPercent === 50 && Array.isArray(st.json?.areas));
  ok("settings has bank shape", st.json?.bank && "number" in st.json.bank);
  ok("settings patch needs auth", (await req("PATCH", "/settings", { body: { dpPercent: 30 } })).status === 401);
  const upd = await req("PATCH", "/settings", { token, body: { dpPercent: 40, bank: { number: "123-456", name: "BCA", holder: "Salia" }, areas: [{ id: "dalam-kota", nama: "Dalam kota", fee: 0 }, { id: "luar-jauh", nama: "Luar", fee: 75000 }], social: { instagram: "https://instagram.com/x" }, whatsapp: "628111" } });
  ok("settings patch applies dp", upd.json?.dpPercent === 40);
  ok("settings patch applies bank", upd.json?.bank?.number === "123-456");
  ok("settings patch applies area fee", upd.json?.areas?.find((a) => a.id === "luar-jauh")?.fee === 75000);
  ok("settings patch applies social", upd.json?.social?.instagram === "https://instagram.com/x");
  ok("settings patch applies whatsapp", upd.json?.whatsapp === "628111");
  // booking now uses the owner-set ongkir (75000 for luar-jauh)
  const bk2 = await req("POST", "/bookings", { body: { nama: "B", telepon: "08", service_id: "makeup", area_id: "luar-jauh", tanggal: "2026-10-05", jam: "09:00" } });
  ok("booking uses settings ongkir", bk2.json?.total === 150000 + 75000);
  // /services echoes dpPercent + owner areas
  const svc2 = await req("GET", "/services");
  ok("services echoes dpPercent", svc2.json?.dpPercent === 40);

  // proof upload (public) without Cloudinary -> 501
  ok("proof upload unconfigured -> 501/400", [501, 400].includes((await req("POST", "/uploads/proof")).status));

  // bookings admin still works
  ok("bookings list", Array.isArray((await req("GET", "/bookings", { token })).json));

  await new Promise((r) => server.close(r));
  if (fail.length) {
    console.error(`booking-flow-test FAILED (${fail.length}):`);
    for (const f of fail) console.error("  - " + f);
    process.exit(1);
  }
  console.log(`booking-flow-test OK — ${pass} assertions.`);
}
main().catch((e) => { console.error("booking-flow-test crashed:", e); process.exit(1); });
