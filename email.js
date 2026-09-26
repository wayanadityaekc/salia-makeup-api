// Email via Resend. Stays OFF until RESEND_API_KEY (+ RESEND_FROM) are set, so
// the receipt-email endpoint degrades gracefully ("skipped") instead of failing.
// Wire it later by adding those env vars on Railway.
function configured() {
  return !!process.env.RESEND_API_KEY && !!process.env.RESEND_FROM;
}

// Send an email with an optional PDF attachment (base64, no data: prefix).
// Returns { ok, id?, skipped?, status?, error? } — never throws.
async function sendEmail({ to, subject, html, attachment }) {
  if (!configured()) return { ok: false, skipped: true, reason: "email_not_configured" };
  try {
    const body = {
      from: process.env.RESEND_FROM,
      to: [to],
      subject,
      html,
    };
    if (attachment && attachment.content) {
      body.attachments = [{ filename: attachment.filename || "struk.pdf", content: attachment.content }];
    }
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) return { ok: false, status: res.status, error: (data && data.message) || "send_failed" };
    return { ok: true, id: data && data.id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { configured, sendEmail };
