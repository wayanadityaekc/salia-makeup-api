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
let chatSeq = 0;
let pushConfig = null;
const bookings = [];
const gallery = [];
const conversations = new Map(); // id -> convo
const chatMessages = []; // { id, conversation_id, sender, body, created_at }
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
    const [id, kind, nama, ringkas, deskripsi, detail, base, hairdo_included, foto, sort, active] = params;
    if (services.some((s) => s.id === id)) { const e = new Error("dup"); e.code = "23505"; throw e; }
    const row = { id, kind, nama, ringkas, deskripsi, detail, base, hairdo_included, foto, sort, active, created_at: new Date().toISOString() };
    services.push(row);
    return { rows: [row], rowCount: 1 };
  }
  if (sql.startsWith("UPDATE services SET")) {
    const [kind, nama, ringkas, base, hairdo_included, foto, sort, active, deskripsi, detail, id] = params;
    const r = services.find((s) => s.id === id);
    if (!r) return { rows: [], rowCount: 0 };
    Object.assign(r, { kind, nama, ringkas, base, hairdo_included, foto, sort, active, deskripsi, detail });
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
    const [nama, telepon, service_id, service_nama, hairdo, area_id, area_nama, tanggal, jam, lokasi, catatan, total, items, orang] = params;
    const row = {
      id: ++bookingSeq, nama, telepon, service_id, service_nama, hairdo,
      area_id, area_nama, tanggal, jam, lokasi, catatan, total,
      items: items ? JSON.parse(items) : null, orang: orang ?? 1,
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
  // live chat
  if (sql.startsWith("INSERT INTO conversations")) {
    const [id, nama, telepon, body] = params;
    const existing = conversations.get(id);
    if (existing) {
      existing.nama = existing.nama || nama;
      existing.telepon = existing.telepon || telepon;
      existing.last_body = body; existing.last_sender = "guest"; existing.last_at = new Date().toISOString();
      existing.owner_unread += 1;
    } else {
      conversations.set(id, { id, nama, telepon, last_body: body, last_sender: "guest", last_at: new Date().toISOString(), owner_unread: 1, created_at: new Date().toISOString() });
    }
    return { rows: [], rowCount: 1 };
  }
  if (sql.startsWith("INSERT INTO chat_messages")) {
    const [conversation_id, , body] = params; // sender is a literal in the SQL
    const sender = sql.includes("'guest'") ? "guest" : "owner";
    const row = { id: ++chatSeq, conversation_id, sender, body, created_at: new Date().toISOString() };
    chatMessages.push(row);
    return { rows: [row], rowCount: 1 };
  }
  if (sql.startsWith("SELECT id, nama FROM conversations WHERE id")) {
    const c = conversations.get(params[0]);
    return { rows: c ? [{ id: c.id, nama: c.nama }] : [], rowCount: c ? 1 : 0 };
  }
  if (sql.startsWith("SELECT * FROM conversations WHERE id")) {
    const c = conversations.get(params[0]);
    return { rows: c ? [c] : [], rowCount: c ? 1 : 0 };
  }
  if (sql.startsWith("SELECT 1 FROM conversations WHERE id")) {
    return { rows: conversations.has(params[0]) ? [{ "?column?": 1 }] : [], rowCount: conversations.has(params[0]) ? 1 : 0 };
  }
  if (sql.startsWith("SELECT id, nama, telepon, last_body")) {
    const rows = [...conversations.values()].sort((a, b) => (a.last_at < b.last_at ? 1 : -1));
    return { rows, rowCount: rows.length };
  }
  if (sql.startsWith("UPDATE conversations SET owner_unread = 0")) {
    const c = conversations.get(params[0]); if (c) c.owner_unread = 0;
    return { rows: [], rowCount: c ? 1 : 0 };
  }
  if (sql.startsWith("UPDATE conversations SET last_body")) {
    const c = conversations.get(params[1]); if (c) { c.last_body = params[0]; c.last_sender = "owner"; c.last_at = new Date().toISOString(); }
    return { rows: [], rowCount: c ? 1 : 0 };
  }
  if (sql.startsWith("SELECT * FROM chat_messages WHERE conversation_id") && sql.includes("id >")) {
    const rows = chatMessages.filter((m) => m.conversation_id === params[0] && m.id > params[1]);
    return { rows, rowCount: rows.length };
  }
  if (sql.startsWith("SELECT * FROM chat_messages WHERE conversation_id")) {
    const rows = chatMessages.filter((m) => m.conversation_id === params[0]);
    return { rows, rowCount: rows.length };
  }
  if (sql.startsWith("DELETE FROM chat_messages WHERE conversation_id")) {
    for (let i = chatMessages.length - 1; i >= 0; i--) if (chatMessages[i].conversation_id === params[0]) chatMessages.splice(i, 1);
    return { rows: [], rowCount: 1 };
  }
  if (sql.startsWith("DELETE FROM conversations WHERE id")) {
    const had = conversations.delete(params[0]);
    return { rows: [], rowCount: had ? 1 : 0 };
  }

  // push (new-booking notify path) — no subscriptions in this suite, so nothing sends
  if (sql.startsWith("SELECT public_key, private_key FROM push_config")) {
    return { rows: pushConfig ? [pushConfig] : [], rowCount: pushConfig ? 1 : 0 };
  }
  if (sql.startsWith("INSERT INTO push_config")) {
    pushConfig = { public_key: params[0], private_key: params[1] };
    return { rows: [pushConfig], rowCount: 1 };
  }
  if (sql.startsWith("SELECT endpoint, p256dh, auth FROM push_subscriptions")) {
    return { rows: [], rowCount: 0 };
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
  ok("hairdo group present", Array.isArray(svcList.json?.hairdo) && svcList.json.hairdo.some((s) => s.id === "hairdo-pesta"));
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

  // cart checkout: 1 makeup + 1 hairdo + 1 nail, 2 people, far ongkir (75000 from settings)
  const cart = await req("POST", "/bookings", {
    body: { nama: "Cart", telepon: "08", items: ["makeup", "hairdo-pesta", "nail-gel"], orang: 2, area_id: "luar-jauh", tanggal: "2026-10-06", jam: "10:00" },
  });
  ok("cart total = sum×orang + ongkir", cart.json?.total === (150000 + 150000 + 150000) * 2 + 75000);
  ok("cart stores items", Array.isArray(cart.json?.items) && cart.json.items.length === 3);
  ok("cart stores orang", cart.json?.orang === 2);
  ok("cart names all items", (cart.json?.service_nama || "").includes(",") );
  ok("cart rejects two of same kind", (await req("POST", "/bookings", { body: { nama: "X", telepon: "08", items: ["makeup", "wisuda"], tanggal: "2026-10-06", jam: "10:00" } })).status === 400);
  ok("cart rejects unknown item", (await req("POST", "/bookings", { body: { nama: "X", telepon: "08", items: ["ghost"], tanggal: "2026-10-06", jam: "10:00" } })).status === 400);
  ok("cart ignores client total", cart.json?.total !== undefined && (await req("POST", "/bookings", { body: { nama: "Z", telepon: "08", items: ["nail-gel"], orang: 1, area_id: "dalam-kota", tanggal: "2026-10-06", jam: "10:00", total: 5 } })).json?.total === 150000);
  // /services echoes dpPercent + owner areas
  const svc2 = await req("GET", "/services");
  ok("services echoes dpPercent", svc2.json?.dpPercent === 40);

  // proof upload (public) without Cloudinary -> 501
  ok("proof upload unconfigured -> 501/400", [501, 400].includes((await req("POST", "/uploads/proof")).status));

  // bookings admin still works
  ok("bookings list", Array.isArray((await req("GET", "/bookings", { token })).json));

  // live chat
  const CID = "conv-abcdef0123456789";
  ok("chat bad cid -> 400", (await req("POST", "/chat/short/messages", { body: { body: "hi" } })).status === 400);
  ok("chat empty -> 400", (await req("POST", `/chat/${CID}/messages`, { body: { body: "" } })).status === 400);
  ok("guest sends -> 201", (await req("POST", `/chat/${CID}/messages`, { body: { nama: "Yulia", telepon: "0812", body: "Halo kak" } })).status === 201);
  ok("chat list needs auth", (await req("GET", "/chat")).status === 401);
  const convos = (await req("GET", "/chat", { token })).json;
  ok("conversation listed w/ unread", Array.isArray(convos) && convos.length === 1 && convos[0].ownerUnread === 1 && convos[0].nama === "Yulia");
  const thread = (await req("GET", `/chat/${CID}`, { token })).json;
  ok("thread has guest message", thread?.messages?.length === 1 && thread.messages[0].sender === "guest");
  ok("open thread clears unread", (await req("GET", "/chat", { token })).json[0].ownerUnread === 0);
  ok("owner reply -> 201", (await req("POST", `/chat/${CID}/reply`, { token, body: { body: "Halo juga" } })).status === 201);
  ok("guest polls owner reply", (await req("GET", `/chat/${CID}/messages?since=0`)).json.messages.some((m) => m.sender === "owner"));
  ok("reply needs auth", (await req("POST", `/chat/${CID}/reply`, { body: { body: "x" } })).status === 401);
  ok("chat delete", (await req("DELETE", `/chat/${CID}`, { token })).json?.ok === true);

  await new Promise((r) => server.close(r));
  if (fail.length) {
    console.error(`booking-flow-test FAILED (${fail.length}):`);
    for (const f of fail) console.error("  - " + f);
    process.exit(1);
  }
  console.log(`booking-flow-test OK — ${pass} assertions.`);
}
main().catch((e) => { console.error("booking-flow-test crashed:", e); process.exit(1); });
