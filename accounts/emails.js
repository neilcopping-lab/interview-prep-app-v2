// The look of Comquat's account emails, and sending them through Resend.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function shell(badge, inner) {
  return `<div style="background:#FFF3E2;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;color:#17191C">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #E9DCC8;border-radius:16px;padding:32px">
    <p style="margin:0 0 24px"><img src="https://cv.the-common-people.com/img/comquat-logo-email.png" width="150" height="39" alt="Comquat" style="display:inline-block;border:0;vertical-align:middle"> <span style="font-size:11px;letter-spacing:2px;background:#17191C;color:#FFF3E2;padding:4px 10px;border-radius:99px;vertical-align:middle;font-family:Arial,Helvetica,sans-serif;font-weight:bold">${esc(badge)}</span></p>
    ${inner}
    <p style="font-size:13px;line-height:1.5;color:#5B5F66;margin:24px 0 0;border-top:1px solid #E9DCC8;padding-top:16px">Comquat is part of The Com'mon People, run by Comquat Ventures UK Ltd. You're getting this because you have a Comquat account with this email address.</p>
  </div>
</div>`;
}
const P = (t) => `<p style="font-size:16px;line-height:1.55;margin:0 0 16px">${t}</p>`;
const BTN = (href, label, colour) =>
  `<a href="${href}" style="display:inline-block;background:${colour || "#1F6B45"};color:#FFF3E2;text-decoration:none;font-weight:bold;font-size:16px;padding:13px 24px;border-radius:6px">${esc(label)}</a>`;

async function sendViaResend(to, msg, headers, attachments) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("no RESEND_API_KEY");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.ACCOUNT_EMAIL_FROM || process.env.RESEND_FROM || "Comquat <cv@the-common-people.com>",
      to: [to], subject: msg.subject, html: msg.html, text: msg.text,
      ...(headers ? { headers } : {}),
      ...(attachments && attachments.length ? { attachments: attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content).toString("base64") })) } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
}

module.exports = { esc, shell, P, BTN, sendViaResend };
