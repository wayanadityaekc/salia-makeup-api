// Server-side price table — the SINGLE source of truth for what a booking costs.
//
// This MIRRORS the frontend table in ../lib/config.js (services, nailArt, areas,
// hairdoAddon). The frontend still shows a live estimate as the guest fills the
// form, but the number that gets STORED is always recomputed here from the
// service_id / area_id / hairdo flags. Never trust a `total` sent by the client.
//
// If you change a price in lib/config.js, change it HERE too, then run
// `node tools/pricing-spec-test.js`. The two tables are kept identical on
// purpose so the estimate the guest saw matches the total the owner sees.

// Make up services. `hairdoIncluded: false` means the hairdo add-on is offered
// for this service; any service without that flag (or with it true) does not
// offer the add-on — same rule the form uses (`"hairdoIncluded" in service`).
const services = [
  { id: "makeup", nama: "Make Up", base: 150000, hairdoIncluded: false },
  { id: "makeup-hairdo", nama: "Make Up + Hairdo", base: 250000, hairdoIncluded: true },
  { id: "wisuda", nama: "Wisuda", base: 300000, hairdoIncluded: true },
  { id: "kundangan", nama: "Kundangan", base: 350000, hairdoIncluded: true },
  { id: "upacara", nama: "Upacara Adat", base: 500000, hairdoIncluded: true },
];

// Nail art services. No `hairdoIncluded` key at all — the add-on never applies.
const nailArt = [
  { id: "nail-polish", nama: "Nail Polish", base: 75000 },
  { id: "nail-gel", nama: "Gel Polish", base: 150000 },
  { id: "nail-extension", nama: "Nail Extension", base: 250000 },
  { id: "nail-design", nama: "Nail Art Design", base: 300000 },
];

const areas = [
  { id: "dalam-kota", nama: "Dalam kota", fee: 0 },
  { id: "luar-20", nama: "Luar kota (< 20 km)", fee: 50000 },
  { id: "luar-jauh", nama: "Luar kota (> 20 km)", fee: 100000 },
];

const hairdoAddon = 100000;

const allServices = [...services, ...nailArt];
const findService = (id) => allServices.find((s) => s.id === id) || null;
const findArea = (id) => areas.find((a) => a.id === id) || null;

// The add-on is offered only when the service carries `hairdoIncluded: false`
// (i.e. plain "Make Up"). Nail art and hairdo-included services never charge it,
// even if the client sends hairdo:true — mirror of `bisaHairdo` in BookingForm.
function offersHairdo(service) {
  return !!service && "hairdoIncluded" in service && service.hairdoIncluded === false;
}

// Recompute a booking from trusted inputs. Returns the resolved names + total,
// or { error } when the service is unknown. Unknown area falls back to zero fee
// (dalam-kota) rather than failing — the area is optional-ish and never required
// by the brief, but the service always is.
function quote({ service_id, area_id, hairdo }) {
  const service = findService(service_id);
  if (!service) return { error: "unknown_service" };

  const area = findArea(area_id) || areas[0];
  const usesHairdo = offersHairdo(service) && !!hairdo;

  const total = service.base + (area.fee || 0) + (usesHairdo ? hairdoAddon : 0);

  return {
    service_id: service.id,
    service_nama: service.nama,
    area_id: area.id,
    area_nama: area.nama,
    hairdo: usesHairdo,
    total,
  };
}

module.exports = {
  services,
  nailArt,
  areas,
  hairdoAddon,
  allServices,
  findService,
  findArea,
  offersHairdo,
  quote,
};
