#!/usr/bin/env node
// Every `mod.thing(...)` in this repo must actually exist on `mod`.
//
// Node cannot catch a missing export for us: `pricing.quotee(...)` is a legal
// expression until it runs, at which point a guest pressing Book gets a 500 in
// production. So we read it statically. Adapted from cahyana-api's version.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const FILES = fs
  .readdirSync(ROOT)
  .filter((f) => f.endsWith(".js"))
  .concat(
    fs
      .readdirSync(path.join(ROOT, "tools"))
      .filter((f) => f.endsWith(".js"))
      .map((f) => "tools/" + f),
  );

const BUILTIN = new Set([
  "then", "catch", "call", "apply", "bind", "toString", "hasOwnProperty", "constructor",
]);

// Strip comments and string literals so a filename in a comment ("./pricing.js")
// is not read as a member access `pricing.js`.
function stripNoise(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
}

let checked = 0;
const bad = [];

for (const rel of FILES) {
  if (rel === "tools/check-exports.js") continue;
  const raw = fs.readFileSync(path.join(ROOT, rel), "utf8");
  const src = stripNoise(raw);

  const bindings = {};
  const re =
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*["'](\.\.?\/[^"']+)["']\s*\)/g;
  let m;
  while ((m = re.exec(raw))) bindings[m[1]] = m[2];

  const fileDir = path.dirname(path.join(ROOT, rel));
  for (const [local, target] of Object.entries(bindings)) {
    let mod;
    try {
      mod = require(path.resolve(fileDir, target));
    } catch (e) {
      bad.push(`${rel}: cannot require ${target} - ${e.message}`);
      continue;
    }
    if (mod === null || typeof mod !== "object") continue;
    const use = new RegExp(`\\b${local}\\.([A-Za-z_$][\\w$]*)`, "g");
    let u;
    while ((u = use.exec(src))) {
      const member = u[1];
      if (BUILTIN.has(member)) continue;
      checked++;
      if (!(member in mod)) {
        bad.push(`${rel}: ${local}.${member} is used but ${target} does not export it`);
      }
    }
  }
}

if (bad.length) {
  console.error("check-exports FAILED:");
  for (const b of bad) console.error("  - " + b);
  process.exit(1);
}
console.log(`check-exports OK — ${checked} member accesses verified across ${FILES.length} files.`);
