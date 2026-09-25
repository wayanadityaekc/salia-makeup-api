# salia-makeup-api

Express + PostgreSQL booking API for Salia Makeup. No payments, no server-side
WhatsApp — the frontend opens `wa.me` after a successful `POST /bookings`.

## Run

```bash
npm install
cp .env.example .env
npm start          # listens on PORT (default 4000), ensures the schema on boot
npm test           # check-exports + pricing-spec + booking-flow (no DB needed)
```

## Env

| var            | notes                                              |
|----------------|----------------------------------------------------|
| `DATABASE_URL` | Postgres connection string                         |
| `JWT_SECRET`   | signs the owner JWT                                |
| `ADMIN_PASSWORD` | single shared owner/dashboard password           |
| `CORS_ORIGIN`  | allowed frontend origin(s), comma-separated        |
| `PORT`         | listen port (Railway sets this)                    |
| `PGSSL`        | set `off` only for a local Postgres without SSL    |

## Endpoints

| method | path            | auth   | body / notes                              |
|--------|-----------------|--------|-------------------------------------------|
| GET    | `/health`       | public | `{ ok: true }`                            |
| POST   | `/auth/login`   | public | `{ password }` → `{ token }`              |
| POST   | `/bookings`     | public | create; server recomputes `total`         |
| GET    | `/bookings`     | admin  | list newest-first; optional `?status=`    |
| PATCH  | `/bookings/:id` | admin  | `{ status }` (`baru`/`konfirmasi`/`selesai`) |
| DELETE | `/bookings/:id` | admin  | delete                                    |

Admin routes need `Authorization: Bearer <token>`; a 401 tells the frontend to
return to the login gate.

## Rules

- **Never trust the client total.** `POST /bookings` recomputes `service_nama`,
  `area_nama` and `total` from `pricing.js` using only `service_id` / `area_id` /
  `hairdo`. `pricing.js` mirrors the frontend `lib/config.js` table — keep them
  identical and run `node tools/pricing-spec-test.js` after any price change.
- **The hairdo add-on** applies only to services flagged `hairdoIncluded: false`
  (plain "Make Up"); nail art and hairdo-included services never charge it, even
  if the client sends `hairdo: true`.
- **Schema is idempotent and never drops** (`db.ensureSchema`) — safe on every boot.

## Deploy (Railway)

Set the env vars above, point the service root at `api/`, start command
`npm start`. Set the frontend's `NEXT_PUBLIC_API_URL` to the deployed URL and
`CORS_ORIGIN` to the site's origin.
