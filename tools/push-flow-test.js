#!/usr/bin/env node
// Verifies the web-push wiring end-to-end against an in-memory Postgres stand-in
// and a stubbed push transport (no network): public key, admin-gated subscribe/
// unsubscribe, that a new booking fires a notification to stored subscriptions,
// that a booking still succeeds when a send throws, and that gone subs (410) are
// pruned. No real push service is contacted.
const http = require("http");

process.env.JWT_SECRET = "test-secret";
process.env.ADMIN_PASSWORD = "hunter2";
process.env.CORS_ORIGIN = "https://saliamakeup.com";

const pricing = require("../pricing");
const db = require("../db");

// --- In-memory tables --------------------------------------------------------
let bookingSeq = 0;
let pushConfig = null;
const subs = [];
const bookings = [];
const services = pricing.SEED_SERVICES.map((s) => ({
  id: s.id, kind: s.kind, nama: s.nama, ringkas: s.ringkas, base: s.base,
  hairdo_included: s.hairdo_included, foto: null, sort: s.sort, active: true,
}));
const settingsRow = {
  id: 1, dp_percent: 50, bank_name: null, bank_number: null, bank_holder: null,
  areas: pricing.areas, instagram_url: null, tiktok_url: null, google_url: null, whatsapp: null,
};

db.ensureSchema = async () => {};
db.pool.query = async (text, params = []) => {
  const sql = text.replace(/\s+/g, " ").trim();

  if (sql.startsWith("SELECT * FROM settings")) return { rows: [settingsRow], rowCount: 1 };
  if (sql.startsWith("SELECT * FROM services WHERE id")) {
    const r = services.find((s) => s.id === params[0]);
    return { rows: r ? [r] : [], rowCount: r ? 1 : 0 };
  }
  if (sql.startsWith("INSERT INTO conversations")) {
    const [id, nama] = params;
    return { rows: [{ id, nama }], rowCount: 1 };
  }
  if (sql.startsWith("INSERT INTO chat_messages")) {
    return { rows: [{ id: 1, conversation_id: params[0], sender: "guest", body: params[1], created_at: new Date().toISOString() }], rowCount: 1 };
  }
  if (sql.startsWith("SELECT id, nama FROM conversations WHERE id")) {
    return { rows: [{ id: params[0], nama: "Yulia" }], rowCount: 1 };
  }
  if (sql.startsWith("INSERT INTO bookings")) {
    const [nama, telepon, service_id, service_nama, hairdo, area_id, area_nama, tanggal, jam, lokasi, catatan, total] = params;
    const row = { id: ++bookingSeq, nama, telepon, service_id, service_nama, hairdo, area_id, area_nama, tanggal, jam, lokasi, catatan, total, status: "baru", created_at: new Date().toISOString() };
    bookings.push(row);
    return { rows: [row], rowCount: 1 };
  }

  // push_config
  if (sql.startsWith("SELECT public_key, private_key FROM push_config")) {
    return { rows: pushConfig ? [pushConfig] : [], rowCount: pushConfig ? 1 : 0 };
  }
  if (sql.startsWith("INSERT INTO push_config")) {
    pushConfig = { public_key: params[0], private_key: params[1] };
    return { rows: [pushConfig], rowCount: 1 };
  }
  // push_subscriptions
  if (sql.startsWith("INSERT INTO push_subscriptions")) {
    const [endpoint, p256dh, auth] = params;
    const i = subs.findIndex((s) => s.endpoint === endpoint);
    if (i >= 0) subs[i] = { endpoint, p256dh, auth };
    else subs.push({ endpoint, p256dh, auth });
    return { rows: [], rowCount: 1 };
  }
  if (sql.startsWith("SELECT endpoint, p256dh, auth FROM push_subscriptions")) {
    return { rows: subs.map((s) => ({ ...s })), rowCount: subs.length };
  }
  if (sql.startsWith("DELETE FROM push_subscriptions")) {
    const i = subs.findIndex((s) => s.endpoint === params[0]);
    if (i === -1) return { rows: [], rowCount: 0 };
    subs.splice(i, 1);
    return { rows: [], rowCount: 1 };
  }

  throw new Error("unexpected query in test: " + sql);
};

// --- Stub the push transport (no network) ------------------------------------
const webpush = require("web-push");
let sent = [];
let failNext = null; // { statusCode } to throw once
webpush.sendNotification = async (sub, data) => {
  if (failNext) { const e = new Error("stub fail"); e.statusCode = failNext.statusCode; failNext = null; throw e; }
  sent.push({ endpoint: sub.endpoint, data: JSON.parse(data) });
  return { statusCode: 201 };
};

const { app } = require("../server");

let pass = 0;
const fail = [];
const ok = (label, cond) => (cond ? pass++ : fail.push(label));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const token = (await req("POST", "/auth/login", { body: { password: "hunter2" } })).json.token;
  const SUB = (id) => ({ endpoint: "https://push.example/" + id, keys: { p256dh: "p-" + id, auth: "a-" + id } });
  const booking = { nama: "Yulia", telepon: "08123", service_id: "makeup", tanggal: "2026-10-01", jam: "10:00" };

  // 1) public key available, looks like a VAPID key
  const pk = await req("GET", "/push/public-key");
  ok("public key returned", typeof pk.json?.publicKey === "string" && pk.json.publicKey.length > 20);

  // 2) subscribe is admin-gated
  ok("subscribe needs auth", (await req("POST", "/push/subscribe", { body: SUB("1") })).status === 401);
  ok("invalid subscription -> 400", (await req("POST", "/push/subscribe", { token, body: { foo: 1 } })).status === 400);
  ok("subscribe ok", (await req("POST", "/push/subscribe", { token, body: SUB("1") })).status === 201);

  // 3) a new booking notifies the subscriber
  sent = [];
  const b1 = await req("POST", "/bookings", { body: booking });
  ok("booking created", b1.status === 201);
  await sleep(50); // notify is fire-and-forget
  ok("one push sent", sent.length === 1);
  ok("push targets the subscriber", sent[0]?.endpoint === "https://push.example/1");
  ok("push names the customer", (sent[0]?.data?.body || "").includes("Yulia"));
  ok("push has a title", (sent[0]?.data?.title || "").length > 0);
  ok("push opens the dashboard", sent[0]?.data?.url === "/dashboard");

  // 3b) a new live-chat message also notifies
  sent = [];
  const m1 = await req("POST", "/chat/conv-abcdef0123456789/messages", { body: { nama: "Yulia", body: "Halo kak mau tanya" } });
  ok("chat message created", m1.status === 201);
  await sleep(50);
  ok("chat push sent", sent.length === 1);
  ok("chat push has snippet", (sent[0]?.data?.body || "").includes("Halo kak"));
  ok("chat push title names guest", (sent[0]?.data?.title || "").includes("Yulia"));

  // 4) two subscribers both get it
  await req("POST", "/push/subscribe", { token, body: SUB("2") });
  sent = [];
  await req("POST", "/bookings", { body: booking });
  await sleep(50);
  ok("both subscribers notified", sent.length === 2);

  // 5) booking still succeeds when a send throws (non-410)
  sent = [];
  failNext = { statusCode: 500 };
  const b3 = await req("POST", "/bookings", { body: booking });
  await sleep(50);
  ok("booking ok despite push error", b3.status === 201);

  // 6) a gone subscription (410) is pruned
  await req("POST", "/push/subscribe", { token, body: SUB("gone") }); // now 3 subs
  failNext = null;
  // make the next send to 'gone' fail with 410 by ordering: force all-410 once via flag
  let orig = webpush.sendNotification;
  webpush.sendNotification = async (sub, data) => {
    if (sub.endpoint.endsWith("/gone")) { const e = new Error("gone"); e.statusCode = 410; throw e; }
    return orig(sub, data);
  };
  await req("POST", "/bookings", { body: booking });
  await sleep(50);
  webpush.sendNotification = orig;
  const listAfter = subs.map((s) => s.endpoint);
  ok("gone subscription pruned", !listAfter.includes("https://push.example/gone"));

  // 7) unsubscribe removes a subscription
  await req("POST", "/push/unsubscribe", { token, body: { endpoint: "https://push.example/1" } });
  ok("unsubscribe removed it", !subs.some((s) => s.endpoint === "https://push.example/1"));

  server.close();
  console.log(`push-flow-test: ${pass} passed, ${fail.length} failed`);
  if (fail.length) { fail.forEach((f) => console.log("  FAIL:", f)); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
