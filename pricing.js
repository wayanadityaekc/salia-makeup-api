// Price rules + the SEED service list.
//
// Services are now editable from the dashboard and live in the `services` DB
// table. This file holds (a) the seed used to populate that table on first boot,
// (b) the fixed bits that are NOT dashboard-editable yet — areas + the hairdo
// add-on, and (c) the total calculation.
//
// The seed here MIRRORS the frontend fallback table in salia-makeup/lib/config.js
// so a fresh install and the frontend agree. `pricing-spec-test.js` checks that.

// Seed make up services. `hairdo_included: false` = the hairdo add-on is offered
// (plain "Make Up"); `true` = already includes hairdo, no add-on.
const SEED_MAKEUP = [
  { id: "makeup", nama: "Make Up", ringkas: "Riasan wajah natural sampai bold sesuai acara.", base: 150000, hairdo_included: false },
  { id: "makeup-hairdo", nama: "Make Up + Hairdo", ringkas: "Paket riasan lengkap dengan penataan rambut.", base: 250000, hairdo_included: true },
  { id: "wisuda", nama: "Wisuda", ringkas: "Tampil elegan dan tahan lama untuk hari kelulusan.", base: 300000, hairdo_included: true },
  { id: "kundangan", nama: "Kundangan", ringkas: "Riasan anggun untuk menghadiri undangan.", base: 350000, hairdo_included: true },
  { id: "upacara", nama: "Upacara Adat", ringkas: "Riasan dan sanggul khas untuk upacara adat Bali.", base: 500000, hairdo_included: true },
];

// Seed hairdo services (own category now — each a card the guest picks). Editable
// from the dashboard like everything else. hairdo_included stays null here.
const SEED_HAIRDO = [
  { id: "hairdo-simpel", nama: "Hairdo Simpel", ringkas: "Penataan rambut rapi untuk sehari-hari / kerja.", base: 100000, hairdo_included: null },
  { id: "hairdo-pesta", nama: "Hairdo Pesta", ringkas: "Sanggul / tatanan elegan untuk acara & pesta.", base: 150000, hairdo_included: null },
  { id: "hairdo-adat", nama: "Sanggul Adat", ringkas: "Sanggul khas untuk upacara & adat Bali.", base: 200000, hairdo_included: null },
];

// Seed nail art services. hairdo_included stays null — the add-on never applies.
const SEED_NAIL = [
  { id: "nail-polish", nama: "Nail Polish", ringkas: "Cat kuku rapi dengan pilihan warna favorit.", base: 75000, hairdo_included: null },
  { id: "nail-gel", nama: "Gel Polish", ringkas: "Gel tahan lama, kilap maksimal hingga 3 minggu.", base: 150000, hairdo_included: null },
  { id: "nail-extension", nama: "Nail Extension", ringkas: "Perpanjangan kuku dengan bentuk sesuai keinginan.", base: 250000, hairdo_included: null },
  { id: "nail-design", nama: "Nail Art Design", ringkas: "Desain custom, hand-painted, dan aksen premium.", base: 300000, hairdo_included: null },
];

// Full seed rows with kind + sort, ready to INSERT.
const SEED_SERVICES = [
  ...SEED_MAKEUP.map((s, i) => ({ ...s, kind: "makeup", sort: i })),
  ...SEED_HAIRDO.map((s, i) => ({ ...s, kind: "hairdo", sort: i })),
  ...SEED_NAIL.map((s, i) => ({ ...s, kind: "nail", sort: i })),
];

// Fixed (not dashboard-editable yet).
const areas = [
  { id: "dalam-kota", nama: "Dalam kota", fee: 0 },
  { id: "luar-20", nama: "Luar kota (< 20 km)", fee: 50000 },
  { id: "luar-jauh", nama: "Luar kota (> 20 km)", fee: 100000 },
];
const hairdoAddon = 100000;

const findArea = (id) => areas.find((a) => a.id === id) || null;

// The add-on is offered only when the service row carries hairdo_included === false
// (plain "Make Up"). Nail art (null) and hairdo-included services never charge it,
// even if the client sends hairdo:true — mirror of `bisaHairdo` in BookingForm.js.
function offersHairdo(service) {
  return !!service && service.hairdo_included === false;
}

// Compute a booking total from a resolved service ROW (from the DB) + trusted
// inputs. `areaList` (from settings) overrides the default areas so the owner's
// dashboard-set ongkir is used. Unknown area falls back to zero fee; the service
// must exist.
function computeTotal({ service, area_id, hairdo, areaList }) {
  if (!service) return { error: "unknown_service" };
  const list = Array.isArray(areaList) && areaList.length ? areaList : areas;
  const area = list.find((a) => a.id === area_id) || list[0];
  const usesHairdo = offersHairdo(service) && !!hairdo;
  const total = Number(service.base) + (area.fee || 0) + (usesHairdo ? hairdoAddon : 0);
  return {
    service_id: service.id,
    service_nama: service.nama,
    area_id: area.id,
    area_nama: area.nama,
    hairdo: usesHairdo,
    total,
  };
}

// Cart total (new checkout): the guest picks up to one item per category
// (makeup / hairdo / nail). Rule (Wayan, Sep 2026):
//   total = (sum of picked item base prices) × jumlah orang + ongkir (once).
// `items` are resolved service ROWS from the DB. Enforces one item per kind.
function computeCart({ items, orang, area_id, areaList }) {
  const rows = (items || []).filter(Boolean);
  if (!rows.length) return { error: "empty_cart" };
  const kinds = new Set();
  for (const r of rows) {
    if (kinds.has(r.kind)) return { error: "duplicate_kind" };
    kinds.add(r.kind);
  }
  const list = Array.isArray(areaList) && areaList.length ? areaList : areas;
  const area = list.find((a) => a.id === area_id) || list[0];
  const people = Math.max(1, parseInt(orang, 10) || 1);
  const subtotal = rows.reduce((s, r) => s + Number(r.base || 0), 0);
  const total = subtotal * people + (area.fee || 0);
  return {
    items: rows.map((r) => ({ id: r.id, nama: r.nama, base: Number(r.base || 0), kind: r.kind })),
    orang: people,
    area_id: area.id,
    area_nama: area.nama,
    subtotal,
    total,
  };
}

module.exports = {
  SEED_MAKEUP,
  SEED_HAIRDO,
  SEED_NAIL,
  SEED_SERVICES,
  areas,
  hairdoAddon,
  findArea,
  offersHairdo,
  computeTotal,
  computeCart,
};
