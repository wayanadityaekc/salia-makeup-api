// Customer-facing email HTML. Inline styles only (email clients strip <style>).
// One builder used for the booking receipt/confirmation email. Sections:
//   1) Receipt — booking details + total
//   2) Privacy / policy notes
//   3) "What to do before your booking" (H-1 prep)
// Kept dependency-free so it renders the same on the server and in a preview.

const ROSE = "#6b2c3e";
const INK = "#241c1e";
const MUTED = "#8a7b7f";
const LINE = "#ead9dd";
const SOFT = "#faf2f4";

function rupiah(n) {
  const v = Math.round(Number(n) || 0);
  return "Rp" + v.toLocaleString("id-ID");
}

function tanggalID(d) {
  if (!d) return "-";
  try {
    return new Date(d).toLocaleDateString("id-ID", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  } catch {
    return String(d);
  }
}

// H-1 prep — mirror of the site's Informasi H-1 (kept here so the API is
// self-contained; if the wording changes, change both).
const PREP_STEPS = [
  ["Persiapan diri", "Sudah siap, sudah mandi, dan sudah berpakaian sesuai jadwal agar semua tepat waktu."],
  ["Area makeup", "Siapkan area yang kondusif, sebaiknya ber-AC/kipas, dengan meja, kursi, dan dekat stop kontak."],
  ["Skincare", "Cukup cuci muka saja; tidak perlu skincare apa pun karena skinprep diberikan oleh MUA."],
  ["Pakaian", "Gunakan baju yang mudah dilepas (kemeja/kancing depan) untuk melapisi baju acara."],
  ["Hairdo", "Rambut kering dan wajib keramas H-1 tanpa conditioner agar mudah di-styling."],
];

const PREP_REMINDER = [
  "Handphone wajib aktif dan tidak silent.",
  "MUA berhak meninggalkan lokasi bila klien tidak bisa dihubungi selama 20 menit; DP dianggap hangus dan tidak bisa di-refund.",
];

function row(label, value, opts = {}) {
  const strong = opts.strong ? `font-weight:700;color:${opts.color || INK};` : `color:${INK};`;
  const size = opts.big ? "font-size:18px;" : "font-size:14px;";
  return `<tr>
    <td style="padding:7px 0;color:${MUTED};font-size:13px;">${label}</td>
    <td style="padding:7px 0;text-align:right;${strong}${size}">${value}</td>
  </tr>`;
}

// booking = { ref, nama, telepon, items:[{nama,base}], orang, areaNama, areaFee,
//             tanggal, jam, total, dpPercent, status }
function customerBookingEmail({ brand = "Salia Makeup", booking = {}, dpPercent = 50 }) {
  const b = booking;
  const items = Array.isArray(b.items) ? b.items : [];
  const orang = b.orang || 1;
  const pct = b.dpPercent || dpPercent;
  const dp = Math.round(((b.total || 0) * pct) / 100);
  const confirmed = b.status === "konfirmasi" || b.status === "selesai";

  const itemRows = items
    .map((it) => row(`${it.nama}${orang > 1 ? ` × ${orang}` : ""}`, rupiah((it.base || 0) * orang)))
    .join("");

  const stepsHtml = PREP_STEPS.map(
    ([t, d], i) =>
      `<tr><td style="padding:8px 0;vertical-align:top;width:26px;color:${ROSE};font-weight:700;font-size:14px;">${i + 1}.</td>
       <td style="padding:8px 0;"><div style="font-weight:700;color:${INK};font-size:14px;">${t}</div>
       <div style="color:${MUTED};font-size:13px;line-height:1.5;margin-top:2px;">${d}</div></td></tr>`,
  ).join("");

  const reminderHtml = PREP_REMINDER.map(
    (r) => `<li style="margin:4px 0;color:${INK};font-size:13px;line-height:1.5;">${r}</li>`,
  ).join("");

  const subject = confirmed
    ? `Booking ${b.ref || ""} dikonfirmasi · ${brand}`.replace(/\s+/g, " ").trim()
    : `Booking ${b.ref || ""} diterima · ${brand}`.replace(/\s+/g, " ").trim();

  const heading = confirmed ? "Booking kamu dikonfirmasi 🎉" : "Terima kasih, booking kamu diterima 🤍";
  const lead = confirmed
    ? "Jadwalmu sudah kami kunci. Sampai jumpa di hari acara!"
    : "Kami sudah menerima booking-mu. Tim kami akan konfirmasi jadwalnya segera.";

  const html = `<!doctype html><html><body style="margin:0;background:${SOFT};font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${SOFT};padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#fff;border:1px solid ${LINE};border-radius:16px;overflow:hidden;">
        <!-- Header -->
        <tr><td style="background:${ROSE};padding:22px 28px;">
          <div style="color:#fff;font-size:20px;font-weight:700;letter-spacing:0.3px;">${brand}</div>
          <div style="color:#f7dfe6;font-size:12px;margin-top:2px;">Struk Booking${b.ref ? " · " + b.ref : ""}</div>
        </td></tr>

        <!-- Intro -->
        <tr><td style="padding:24px 28px 8px;">
          <div style="font-size:18px;font-weight:700;color:${INK};">${heading}</div>
          <div style="font-size:14px;color:${MUTED};line-height:1.6;margin-top:6px;">Halo ${b.nama || "kak"}, ${lead}</div>
        </td></tr>

        <!-- Receipt -->
        <tr><td style="padding:8px 28px 4px;">
          <div style="font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${ROSE};margin-bottom:6px;">Detail Booking</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${LINE};">
            ${row("Nama", b.nama || "-")}
            ${b.telepon ? row("No. WhatsApp", b.telepon) : ""}
            ${row("Tanggal", tanggalID(b.tanggal))}
            ${row("Jam ready", b.jam || "-")}
            ${b.areaNama ? row("Area", b.areaNama) : ""}
            ${row("Jumlah orang", `${orang} orang`)}
          </table>
        </td></tr>

        <!-- Items + total -->
        <tr><td style="padding:8px 28px 4px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${LINE};">
            ${itemRows || row("Layanan", "-")}
            ${b.areaFee > 0 ? row("Ongkir", rupiah(b.areaFee)) : ""}
          </table>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:2px solid ${LINE};margin-top:4px;">
            ${row("Total", rupiah(b.total), { strong: true, big: true, color: ROSE })}
            ${row(`DP ${pct}%`, rupiah(dp))}
          </table>
        </td></tr>

        <!-- Privacy / policy -->
        <tr><td style="padding:14px 28px 4px;">
          <div style="background:${SOFT};border:1px solid ${LINE};border-radius:12px;padding:14px 16px;">
            <div style="font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${ROSE};">Kebijakan &amp; Privasi</div>
            <p style="font-size:12px;color:${MUTED};line-height:1.6;margin:8px 0 0;">
              DP mengunci jadwalmu dan tidak dapat dikembalikan bila booking dibatalkan.
              Pelunasan dilakukan di hari acara. Data yang kamu berikan (nama, nomor, alamat)
              hanya kami gunakan untuk mengurus booking ini dan tidak dibagikan ke pihak lain.
            </p>
          </div>
        </td></tr>

        <!-- Prep -->
        <tr><td style="padding:16px 28px 4px;">
          <div style="font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${ROSE};margin-bottom:2px;">Persiapan sebelum booking (H-1)</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${stepsHtml}</table>
          <div style="background:${SOFT};border:1px solid ${LINE};border-radius:12px;padding:12px 16px;margin-top:10px;">
            <div style="font-weight:700;color:${INK};font-size:13px;margin-bottom:4px;">Pengingat</div>
            <ul style="margin:0;padding-left:18px;">${reminderHtml}</ul>
          </div>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:20px 28px 26px;text-align:center;">
          <div style="font-size:13px;color:${MUTED};">Ada pertanyaan? Balas email ini atau chat kami.</div>
          <div style="font-size:12px;color:${MUTED};margin-top:10px;">© ${new Date().getFullYear()} ${brand} · See you for your special moment 🤍</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
  </body></html>`;

  return { subject, html };
}

// Sample booking so the preview/test render without a real record.
const SAMPLE_BOOKING = {
  ref: "SALIA-128",
  nama: "Dewi Lestari",
  telepon: "081234567890",
  items: [
    { nama: "Make Up Wisuda", base: 300000 },
    { nama: "Hairdo Pesta", base: 150000 },
  ],
  orang: 1,
  areaNama: "Luar kota (< 20 km)",
  areaFee: 50000,
  tanggal: new Date(Date.now() + 6 * 864e5).toISOString().slice(0, 10),
  jam: "09:00",
  total: 500000,
  dpPercent: 50,
  status: "konfirmasi",
};

module.exports = { customerBookingEmail, SAMPLE_BOOKING };
