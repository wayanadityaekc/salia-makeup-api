#!/usr/bin/env node
// Customer accounts + receipt-email endpoint, against an in-memory users table.
// No DB, no network, no Resend (email stays "skipped").
const http = require("http");

process.env.JWT_SECRET = "test-secret";
process.env.ADMIN_PASSWORD = "hunter2";
process.env.CORS_ORIGIN = "https://saliamakeup.com";
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_FROM;

const db = require("./../db");

let userSeq = 0;
const users = [];
db.ensureSchema = async () => {};
db.pool.query = async (text, params = []) => {
  const sql = text.replace(/\s+/g, " ").trim();
  if (sql.startsWith("INSERT INTO users")) {
    const [nama, email, telepon, password_hash, chat_cid] = params;
    if (users.some((u) => (email && u.email === email) || (telepon && u.telepon === telepon))) {
      const e = new Error("dup"); e.code = "23505"; throw e;
    }
    const row = { id: ++userSeq, nama, email, telepon, password_hash, chat_cid, created_at: new Date().toISOString() };
    users.push(row);
    return { rows: [row], rowCount: 1 };
  }
  if (sql.startsWith("SELECT * FROM users WHERE email")) {
    const u = users.find((x) => x.email === params[0] || x.telepon === params[1]);
    return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
  }
  if (sql.startsWith("SELECT * FROM users WHERE id")) {
    const u = users.find((x) => String(x.id) === String(params[0]));
    return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
  }
  throw new Error("unexpected query: " + sql);
};

const { app } = require("./../server");

let pass = 0;
const fail = [];
const ok = (l, c) => (c ? pass++ : fail.push(l));

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

  ok("register needs email/phone", (await req("POST", "/users/register", { body: { nama: "A", password: "secret1" } })).status === 400);
  ok("register short password", (await req("POST", "/users/register", { body: { nama: "A", telepon: "08123", password: "x" } })).status === 400);
  const reg = await req("POST", "/users/register", { body: { nama: "Yulia", telepon: "08123", email: "y@mail.com", password: "secret1" } });
  ok("register ok -> token", reg.status === 201 && typeof reg.json?.token === "string");
  ok("register returns chatCid", !!reg.json?.user?.chatCid);
  ok("duplicate -> 409", (await req("POST", "/users/register", { body: { nama: "B", telepon: "08123", password: "secret1" } })).status === 409);

  ok("login wrong password -> 401", (await req("POST", "/users/login", { body: { identifier: "y@mail.com", password: "nope" } })).status === 401);
  const login = await req("POST", "/users/login", { body: { identifier: "08123", password: "secret1" } });
  ok("login by phone ok", login.status === 200 && typeof login.json?.token === "string");
  const loginByEmail = await req("POST", "/users/login", { body: { identifier: "y@mail.com", password: "secret1" } });
  ok("login by email ok", loginByEmail.status === 200);

  const token = login.json.token;
  ok("me needs auth", (await req("GET", "/users/me")).status === 401);
  ok("me returns profile", (await req("GET", "/users/me", { token })).json?.user?.nama === "Yulia");
  ok("admin token rejected on user route", (await req("GET", "/users/me", { token: (await req("POST", "/auth/login", { body: { password: "hunter2" } })).json.token })).status === 401);

  // receipt email: Resend unconfigured -> skipped
  const mail = await req("POST", "/receipt/email", { token, body: { ref: "SALIA-1", pdfBase64: "abc" } });
  ok("receipt email skipped when unconfigured", mail.json?.skipped === true && mail.json?.reason === "email_not_configured");

  await new Promise((r) => server.close(r));
  console.log(`user-flow-test: ${pass} passed, ${fail.length} failed`);
  if (fail.length) { fail.forEach((f) => console.error("  - " + f)); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
