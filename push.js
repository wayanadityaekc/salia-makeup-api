// Web Push for the owner's admin PWA — a native notification when a new booking
// lands, even with the app closed.
//
// Keys: the VAPID keypair is generated once and stored in the DB (push_config),
// so there is no env to set — it "just works" after deploy. The PRIVATE key never
// leaves the server (only /push/public-key is exposed). Subscriptions live in
// push_subscriptions and are pruned automatically when a browser drops them.
//
// notifyNewBooking is fire-and-forget: a push failure must never break a booking.
const webpush = require("web-push");
const { pool } = require("./db");

let publicKey = null;
let configured = false;

async function ensurePushSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_config (
      id          INTEGER PRIMARY KEY DEFAULT 1,
      public_key  TEXT NOT NULL,
      private_key TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT push_config_singleton CHECK (id = 1)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint   TEXT PRIMARY KEY,
      p256dh     TEXT NOT NULL,
      auth       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await loadKeys();
}

// Load the VAPID keypair, generating + persisting it on first ever boot.
async function loadKeys() {
  let { rows } = await pool.query("SELECT public_key, private_key FROM push_config WHERE id = 1");
  if (!rows.length) {
    const keys = webpush.generateVAPIDKeys();
    await pool.query(
      "INSERT INTO push_config (id, public_key, private_key) VALUES (1,$1,$2) ON CONFLICT (id) DO NOTHING",
      [keys.publicKey, keys.privateKey],
    );
    ({ rows } = await pool.query("SELECT public_key, private_key FROM push_config WHERE id = 1"));
  }
  const subject = process.env.VAPID_SUBJECT || "mailto:owner@saliamakeup.com";
  webpush.setVapidDetails(subject, rows[0].public_key, rows[0].private_key);
  publicKey = rows[0].public_key;
  configured = true;
  return publicKey;
}

async function getPublicKey() {
  if (!publicKey) await loadKeys();
  return publicKey;
}

// Store (or refresh) a browser's push subscription. Body shape is the standard
// PushSubscription.toJSON(): { endpoint, keys: { p256dh, auth } }.
async function subscribe(sub) {
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    const e = new Error("invalid_subscription");
    e.code = "invalid_subscription";
    throw e;
  }
  await pool.query(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES ($1,$2,$3)
     ON CONFLICT (endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
    [sub.endpoint, sub.keys.p256dh, sub.keys.auth],
  );
}

async function unsubscribe(endpoint) {
  if (!endpoint) return;
  await pool.query("DELETE FROM push_subscriptions WHERE endpoint = $1", [endpoint]);
}

// Send a payload to every stored subscription; drop ones the push service says
// are gone (404/410). Returns { sent, pruned }.
async function sendToAll(payload) {
  if (!configured) await loadKeys();
  const { rows } = await pool.query("SELECT endpoint, p256dh, auth FROM push_subscriptions");
  const data = JSON.stringify(payload);
  let sent = 0;
  let pruned = 0;
  await Promise.all(
    rows.map(async (r) => {
      const sub = { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } };
      try {
        await webpush.sendNotification(sub, data);
        sent++;
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) {
          pruned++;
          await pool.query("DELETE FROM push_subscriptions WHERE endpoint = $1", [r.endpoint]).catch(() => {});
        } else {
          console.error("push send failed:", e.statusCode || e.message);
        }
      }
    }),
  );
  return { sent, pruned };
}

// Fire-and-forget: notify the owner of a new booking. Never throws.
function notifyNewBooking(b) {
  const extra = b.hairdo ? " + Hairdo" : "";
  const when = [b.tanggal, b.jam].filter(Boolean).join(" ");
  const body = `${b.nama} — ${b.service_nama || "layanan"}${extra}${when ? " · " + when : ""}`;
  sendToAll({ title: "Booking baru masuk", body, tag: `booking-${b.id}`, url: "/dashboard" }).catch((e) =>
    console.error("notifyNewBooking:", e.message),
  );
}

// Fire-and-forget: notify the owner of a new live-chat message. Never throws.
// Uses one tag per conversation so rapid messages collapse into one notification.
function notifyNewChat(convo, body) {
  const snippet = String(body || "").slice(0, 90);
  sendToAll({
    title: `Chat: ${convo.nama || "Tamu"}`,
    body: snippet,
    tag: `chat-${convo.id}`,
    url: "/dashboard",
  }).catch((e) => console.error("notifyNewChat:", e.message));
}

module.exports = {
  ensurePushSchema,
  loadKeys,
  getPublicKey,
  subscribe,
  unsubscribe,
  sendToAll,
  notifyNewBooking,
  notifyNewChat,
};
