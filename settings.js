// Site settings the owner controls from the dashboard: DP percentage, bank
// account for transfers, per-area delivery fees (ongkir), and social links.
// Stored as a single row (id = 1). Bank number + social links are meant to be
// public (shown on the site), so /settings is a public read.
const { pool } = require("./db");
const pricing = require("./pricing");

const DEFAULTS = {
  dp_percent: 50,
  bank_name: "",
  bank_number: "",
  bank_holder: "",
  areas: pricing.areas, // [{id, nama, fee}]
  instagram_url: "",
  tiktok_url: "",
  google_url: "",
  whatsapp: "",
};

// Read the singleton row, creating it from defaults on first call.
async function getSettings() {
  const { rows } = await pool.query("SELECT * FROM settings WHERE id = 1");
  if (!rows.length) {
    await pool.query(
      `INSERT INTO settings (id, dp_percent, areas) VALUES (1, $1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [DEFAULTS.dp_percent, JSON.stringify(DEFAULTS.areas)],
    );
    return getSettings();
  }
  const r = rows[0];
  return {
    dpPercent: r.dp_percent,
    bank: { name: r.bank_name || "", number: r.bank_number || "", holder: r.bank_holder || "" },
    areas: Array.isArray(r.areas) ? r.areas : DEFAULTS.areas,
    social: { instagram: r.instagram_url || "", tiktok: r.tiktok_url || "", google: r.google_url || "" },
    whatsapp: r.whatsapp || "",
    // Editable homepage content. Empty strings = frontend falls back to its
    // hardcoded defaults, so nothing breaks before the owner sets anything.
    content: {
      logo: r.logo_url || "",
      heroKicker: r.hero_kicker || "",
      heroTitle: r.hero_title || "",
      heroPhoto: r.hero_photo || "",
    },
  };
}

// Update only provided fields. Accepts the same shape /settings returns.
async function updateSettings(body) {
  const cur = await getSettings();
  const dpPercent =
    body.dpPercent !== undefined ? Math.min(100, Math.max(0, parseInt(body.dpPercent, 10) || 0)) : cur.dpPercent;
  const bank = { ...cur.bank, ...(body.bank || {}) };
  const social = { ...cur.social, ...(body.social || {}) };
  // areas: keep shape, coerce fees to non-negative integers.
  const areas = Array.isArray(body.areas)
    ? body.areas.map((a) => ({ id: a.id, nama: a.nama, fee: Math.max(0, parseInt(a.fee, 10) || 0) }))
    : cur.areas;
  const whatsapp = body.whatsapp !== undefined ? String(body.whatsapp) : cur.whatsapp;
  const content = { ...cur.content, ...(body.content || {}) };

  await pool.query(
    `UPDATE settings SET dp_percent=$1, bank_name=$2, bank_number=$3, bank_holder=$4,
       areas=$5, instagram_url=$6, tiktok_url=$7, google_url=$8, whatsapp=$9,
       logo_url=$10, hero_kicker=$11, hero_title=$12, hero_photo=$13, updated_at=NOW() WHERE id=1`,
    [dpPercent, bank.name, bank.number, bank.holder, JSON.stringify(areas), social.instagram, social.tiktok, social.google, whatsapp,
     content.logo || "", content.heroKicker || "", content.heroTitle || "", content.heroPhoto || ""],
  );
  return getSettings();
}

module.exports = { getSettings, updateSettings, DEFAULTS };
