#!/usr/bin/env node
// Customer accounts + receipt-email endpoint, against an in-memory users table.
// No DB, no network, no Resend (email stays "skipped").
const http = require("http");

process.env.JWT_SECRET = "test-secret";
process.env.ADMIN_PASSWORD = "hunter2";
process.env.CORS_ORIGIN = "https://saliamakeup.com";
process.env.EXPOSE_LOGIN_CODE = "1"; // dev/test only: request-code echoes the code
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_FROM;

const db = require("./../db");

let userSeq = 0;
const users = [];
let codeSeq = 0;
const codes = []; // login_codes
db.ensureSchema = async () => {};
db.pool.query = async (text, params = []) => {
  const sql = text.replace(/\s+/g, " ").trim();
  // login codes (OTP)
  if (sql.startsWith("UPDATE login_codes SET used_at = NOW() WHERE email")) {
    codes.forEach((c) => { if (c.email === params[0] && !c.used_at) c.used_at = new Date().toISOString(); });
    return { rows: [], rowCount: 1 };
  }
  if (sql.startsWith("INSERT INTO login_codes")) {
    const [email, code_hash] = params;
    const row = { id: ++codeSeq, email, code_hash, expires_at: new Date(Date.now() + 6e5).toISOString(), used_at: null };
    codes.push(row);
    return { rows: [row], rowCount: 1 };
  }
  if (sql.startsWith("SELECT * FROM login_codes WHERE email")) {
    const [email, code_hash] = params;
    const row = [...codes].reverse().find((c) => c.email === email && c.code_hash === code_hash && !c.used_at && new Date(c.expires_at) > new Date());
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }
  if (sql.startsWith("UPDATE login_codes SET used_at = NOW() WHERE id")) {
    const c = codes.find((x) => String(x.id) === String(params[0])); if (c) c.used_at = new Date().toISOString();
    return { rows: [], rowCount: c ? 1 : 0 };
  }
  // email-only account (passwordless upsert)
  if (sql.startsWith("INSERT INTO users (nama, email, chat_cid)")) {
    const [nama, email, chat_cid] = params;
    if (users.some((u) => email && u.email === email)) { const e = new Error("dup"); e.code = "23505"; throw e; }
    const row = { id: ++userSeq, nama, email, telepon: null, password_hash: null, chat_cid, created_at: new Date().toISOString() };
    users.push(row);
    return { rows: [row], rowCount: 1 };
  }
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

  // --- Passwordless email login (OTP) ---
  ok("request-code invalid email -> 400", (await req("POST", "/users/request-code", { body: { email: "nope" } })).status === 400);
  const rc = await req("POST", "/users/request-code", { body: { email: "new@mail.com" } });
  ok("request-code ok", rc.status === 200 && rc.json?.ok === true && /^\d{6}$/.test(rc.json?.code || ""));
  ok("verify wrong code -> 401", (await req("POST", "/users/verify-code", { body: { email: "new@mail.com", code: "000000" } })).status === 401);
  const vc = await req("POST", "/users/verify-code", { body: { email: "new@mail.com", code: rc.json.code } });
  ok("verify ok -> token + creates account", vc.status === 200 && typeof vc.json?.token === "string" && vc.json?.user?.email === "new@mail.com");
  ok("otp account has chatCid", !!vc.json?.user?.chatCid);
  ok("me works with otp token", (await req("GET", "/users/me", { token: vc.json.token })).json?.user?.email === "new@mail.com");
  const rc2 = await req("POST", "/users/request-code", { body: { email: "new@mail.com" } });
  ok("code single-use (reuse old -> 401)", (await req("POST", "/users/verify-code", { body: { email: "new@mail.com", code: rc.json.code } })).status === 401);
  ok("new code works", (await req("POST", "/users/verify-code", { body: { email: "new@mail.com", code: rc2.json.code } })).status === 200);

  await new Promise((r) => server.close(r));
  console.log(`user-flow-test: ${pass} passed, ${fail.length} failed`);
  if (fail.length) { fail.forEach((f) => console.error("  - " + f)); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
