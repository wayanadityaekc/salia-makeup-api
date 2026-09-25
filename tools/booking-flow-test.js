#!/usr/bin/env node
// What actually happens when a guest presses Book, and when the owner manages
// bookings. Boots the real Express app with an in-memory stand-in for Postgres
// (no DB, no network) and drives it over HTTP. Adapted from cahyana-api's
// inquiry-flow-test.
const http = require("http");

// Env the app needs before it (and auth.js) load.
process.env.JWT_SECRET = "test-secret";
process.env.ADMIN_PASSWORD = "hunter2";
process.env.CORS_ORIGIN = "https://saliamakeup.com";

// --- In-memory Postgres stub -------------------------------------------------
const db = require("../db");
let seq = 0;
const store = [];
db.ensureSchema = async () => {}; // no real schema
db.pool.query = async (text, params = []) => {
  const sql = text.replace(/\s+/g, " ").trim();

  if (sql.startsWith("INSERT INTO bookings")) {
    const [nama, telepon, service_id, service_nama, hairdo, area_id, area_nama, tanggal, jam, lokasi, catatan, total] = params;
    const row = {
      id: ++seq, nama, telepon, service_id, service_nama, hairdo,
      area_id, area_nama, tanggal, jam, lokasi, catatan, total,
      status: "baru", created_at: new Date().toISOString(),
    };
    store.push(row);
    return { rows: [row], rowCount: 1 };
  }
  if (sql.startsWith("SELECT * FROM bookings WHERE status")) {
    const rows = store.filter((r) => r.status === params[0]).reverse();
    return { rows, rowCount: rows.length };
  }
  if (sql.startsWith("SELECT * FROM bookings")) {
    return { rows: [...store].reverse(), rowCount: store.length };
  }
  if (sql.startsWith("UPDATE bookings SET status")) {
    const r = store.find((x) => String(x.id) === String(params[1]));
    if (!r) return { rows: [], rowCount: 0 };
    r.status = params[0];
    return { rows: [r], rowCount: 1 };
  }
  if (sql.startsWith("DELETE FROM bookings")) {
    const i = store.findIndex((x) => String(x.id) === String(params[0]));
    if (i === -1) return { rows: [], rowCount: 0 };
    store.splice(i, 1);
    return { rows: [], rowCount: 1 };
  }
  throw new Error("unexpected query in test: " + sql);
};

const { app } = require("../server");

let pass = 0;
const fail = [];
function ok(label, cond) {
  if (cond) pass++;
  else fail.push(label);
}

async function main() {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = async (method, path, { body, token } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: "Bearer " + token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };

  // health
  ok("health ok", (await req("GET", "/health")).json?.ok === true);

  // create booking (public) — server recomputes the total, ignores client total
  const create = await req("POST", "/bookings", {
    body: {
      nama: "Ayu", telepon: "08123", service_id: "makeup",
      area_id: "luar-jauh", hairdo: true, tanggal: "2026-10-01", jam: "10:00",
      total: 999999, // hostile client value, must be ignored
    },
  });
  ok("create -> 201", create.status === 201);
  ok("total recomputed server-side", create.json?.total === 350000); // 150k + 100k area + 100k hairdo
  ok("service_nama resolved", create.json?.service_nama === "Make Up");
  ok("status defaults baru", create.json?.status === "baru");
  const id = create.json?.id;

  // missing required field -> 400
  const bad = await req("POST", "/bookings", { body: { nama: "X", telepon: "08" } });
  ok("missing fields -> 400", bad.status === 400);
  ok("400 names missing fields", Array.isArray(bad.json?.fields) && bad.json.fields.includes("service_id"));

  // unknown service -> 400
  const badSvc = await req("POST", "/bookings", {
    body: { nama: "X", telepon: "08", service_id: "nope", tanggal: "2026-10-01", jam: "10:00" },
  });
  ok("unknown service -> 400", badSvc.status === 400 && badSvc.json?.error === "unknown_service");

  // admin routes require a token
  ok("GET /bookings without token -> 401", (await req("GET", "/bookings")).status === 401);
  ok("PATCH without token -> 401", (await req("PATCH", "/bookings/" + id, { body: { status: "selesai" } })).status === 401);

  // login
  ok("wrong password -> 401", (await req("POST", "/auth/login", { body: { password: "nope" } })).status === 401);
  const login = await req("POST", "/auth/login", { body: { password: "hunter2" } });
  ok("login -> token", typeof login.json?.token === "string" && login.json.token.length > 10);
  const token = login.json.token;

  // list
  const list = await req("GET", "/bookings", { token });
  ok("list returns the booking", Array.isArray(list.json) && list.json.length === 1 && list.json[0].id === id);

  // patch status
  const patch = await req("PATCH", "/bookings/" + id, { token, body: { status: "konfirmasi" } });
  ok("patch -> status changed", patch.json?.status === "konfirmasi");
  const patchBad = await req("PATCH", "/bookings/" + id, { token, body: { status: "wat" } });
  ok("invalid status -> 400", patchBad.status === 400);

  // filter by status
  const filtered = await req("GET", "/bookings?status=konfirmasi", { token });
  ok("filter status=konfirmasi", filtered.json.length === 1);
  const filteredEmpty = await req("GET", "/bookings?status=selesai", { token });
  ok("filter status=selesai empty", filteredEmpty.json.length === 0);

  // delete
  ok("delete -> ok", (await req("DELETE", "/bookings/" + id, { token })).json?.ok === true);
  ok("delete again -> 404", (await req("DELETE", "/bookings/" + id, { token })).status === 404);
  ok("list empty after delete", (await req("GET", "/bookings", { token })).json.length === 0);

  await new Promise((r) => server.close(r));

  if (fail.length) {
    console.error(`booking-flow-test FAILED (${fail.length}):`);
    for (const f of fail) console.error("  - " + f);
    process.exit(1);
  }
  console.log(`booking-flow-test OK — ${pass} assertions.`);
}

main().catch((e) => {
  console.error("booking-flow-test crashed:", e);
  process.exit(1);
});
