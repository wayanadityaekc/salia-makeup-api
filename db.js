// PostgreSQL access + schema bootstrap. One pool for the process.
const { Pool } = require("pg");
const pricing = require("./pricing");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "off" ? false : { rejectUnauthorized: false },
});

// Idempotent: safe to run on every boot. Creates tables if missing, seeds the
// service list once. No DROP anywhere — losing a booking loses a real customer.
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id           SERIAL PRIMARY KEY,
      nama         TEXT NOT NULL,
      telepon      TEXT NOT NULL,
      service_id   TEXT NOT NULL,
      service_nama TEXT,
      hairdo       BOOLEAN NOT NULL DEFAULT FALSE,
      area_id      TEXT,
      area_nama    TEXT,
      tanggal      DATE,
      jam          TEXT,
      lokasi       TEXT,
      catatan      TEXT,
      total        INTEGER NOT NULL DEFAULT 0,
      status       TEXT NOT NULL DEFAULT 'baru',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS services (
      id              TEXT PRIMARY KEY,
      kind            TEXT NOT NULL,            -- 'makeup' | 'nail'
      nama            TEXT NOT NULL,
      ringkas         TEXT,
      base            INTEGER NOT NULL DEFAULT 0,
      hairdo_included BOOLEAN,                  -- null for nail art
      foto            TEXT,
      sort            INTEGER NOT NULL DEFAULT 0,
      active          BOOLEAN NOT NULL DEFAULT TRUE,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS gallery (
      id         SERIAL PRIMARY KEY,
      url        TEXT NOT NULL,
      caption    TEXT,
      sort       INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await seedServices();
}

// Populate the services table from the seed ONLY when it's empty — never
// overwrites what the owner has since edited.
async function seedServices() {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM services");
  if (rows[0].n > 0) return;
  for (const s of pricing.SEED_SERVICES) {
    await pool.query(
      `INSERT INTO services (id, kind, nama, ringkas, base, hairdo_included, sort, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE)
       ON CONFLICT (id) DO NOTHING`,
      [s.id, s.kind, s.nama, s.ringkas, s.base, s.hairdo_included, s.sort],
    );
  }
}

module.exports = { pool, ensureSchema, seedServices };
