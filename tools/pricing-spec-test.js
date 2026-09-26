#!/usr/bin/env node
// Asserts the server price rules, and (when the frontend repo is checked out
// alongside) that the seed service table matches the frontend fallback table in
// salia-makeup/lib/config.js. The mirror check is SKIPPED (not failed) if the
// frontend clone isn't next to this one — same pattern as cahyana-api's
// check-prices needing the CUE clone.
const fs = require("fs");
const path = require("path");
const pricing = require("../pricing");

let pass = 0;
const fail = [];
function eq(label, got, want) {
  if (got === want) pass++;
  else fail.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

const svc = (id) => pricing.SEED_SERVICES.find((s) => s.id === id);

// --- Rules (computeTotal takes a resolved service ROW) ------------------------
eq("makeup base", pricing.computeTotal({ service: svc("makeup"), area_id: "dalam-kota" }).total, 150000);
eq("makeup + hairdo", pricing.computeTotal({ service: svc("makeup"), area_id: "dalam-kota", hairdo: true }).total, 250000);
eq("makeup + far area", pricing.computeTotal({ service: svc("makeup"), area_id: "luar-jauh" }).total, 250000);
eq("makeup + hairdo + far", pricing.computeTotal({ service: svc("makeup"), area_id: "luar-jauh", hairdo: true }).total, 350000);
eq("wisuda ignores hairdo flag", pricing.computeTotal({ service: svc("wisuda"), area_id: "dalam-kota", hairdo: true }).total, 300000);
eq("nail gel ignores hairdo flag", pricing.computeTotal({ service: svc("nail-gel"), area_id: "dalam-kota", hairdo: true }).total, 150000);
eq("no service errors", pricing.computeTotal({ service: null }).error, "unknown_service");
eq("unknown area -> zero fee", pricing.computeTotal({ service: svc("makeup"), area_id: "nope" }).total, 150000);
eq("service_nama resolved", pricing.computeTotal({ service: svc("nail-design"), area_id: "dalam-kota" }).service_nama, "Nail Art Design");
eq("area_nama resolved", pricing.computeTotal({ service: svc("makeup"), area_id: "luar-20" }).area_nama, "Luar kota (< 20 km)");
// hairdo add-on only offered when hairdo_included === false
eq("offersHairdo makeup", pricing.offersHairdo(svc("makeup")), true);
eq("offersHairdo wisuda", pricing.offersHairdo(svc("wisuda")), false);
eq("offersHairdo nail (null)", pricing.offersHairdo(svc("nail-gel")), false);

// --- Cart rules: total = sum(item base) × orang + ongkir (once) ---------------
const cart = (ids, orang, area_id) =>
  pricing.computeCart({ items: ids.map(svc), orang, area_id });
eq("cart single item", cart(["makeup"], 1, "dalam-kota").total, 150000);
eq("cart × orang", cart(["makeup"], 3, "dalam-kota").total, 450000);
eq("cart sum × orang + ongkir once", cart(["makeup", "nail-gel"], 2, "luar-jauh").total, (150000 + 150000) * 2 + 100000);
eq("cart 3 categories", cart(["makeup", "hairdo-pesta", "nail-gel"], 1, "dalam-kota").total, 150000 + 150000 + 150000);
eq("cart empty -> error", pricing.computeCart({ items: [], orang: 1 }).error, "empty_cart");
eq("cart two same kind -> error", cart(["makeup", "wisuda"], 1, "dalam-kota").error, "duplicate_kind");
eq("cart orang floor 1", cart(["makeup"], 0, "dalam-kota").orang, 1);
eq("cart subtotal reported", cart(["makeup", "nail-gel"], 5, "dalam-kota").subtotal, 300000);

// --- Seed table === frontend fallback table ----------------------------------
const CANDIDATES = [
  path.join(__dirname, "..", "..", "salia-makeup", "lib", "config.js"),
  path.join(__dirname, "..", "..", "lib", "config.js"),
];
const cfgPath = CANDIDATES.find((p) => fs.existsSync(p));
if (!cfgPath) {
  console.log(
    `pricing-spec-test OK — ${pass} rule assertions.\n` +
      "  (frontend table mirror check SKIPPED: salia-makeup clone not found alongside.)",
  );
  process.exit(fail.length ? 1 : 0);
}
const cfg = fs.readFileSync(cfgPath, "utf8");
const baseFor = (id) => {
  const m = cfg.match(new RegExp(`id:\\s*"${id}"[\\s\\S]*?base:\\s*(\\d+)`));
  return m ? Number(m[1]) : null;
};
const feeFor = (id) => {
  const m = cfg.match(new RegExp(`id:\\s*"${id}"[\\s\\S]*?fee:\\s*(\\d+)`));
  return m ? Number(m[1]) : null;
};
for (const s of pricing.SEED_SERVICES) eq(`frontend base matches ${s.id}`, baseFor(s.id), s.base);
for (const a of pricing.areas) eq(`frontend fee matches ${a.id}`, feeFor(a.id), a.fee);
const addon = cfg.match(/hairdoAddon\s*=\s*(\d+)/);
eq("frontend hairdoAddon matches", addon ? Number(addon[1]) : null, pricing.hairdoAddon);

if (fail.length) {
  console.error(`pricing-spec-test FAILED (${fail.length}):`);
  for (const f of fail) console.error("  - " + f);
  process.exit(1);
}
console.log(`pricing-spec-test OK — ${pass} assertions.`);
