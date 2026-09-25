// PostgreSQL access + schema bootstrap. One pool for the process.
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway/most managed Postgres present a cert the container does not have in
  // its trust store; this is the same setting cahyana-api uses.
  ssl: process.env.PGSSL === "off" ? false : { rejectUnauthorized: false },
});

// Idempotent: safe to run on every boot. Creates the bookings table if missing.
// No DROP anywhere — losing a booking loses a real customer.
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
}

module.exports = { pool, ensureSchema };
