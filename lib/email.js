/**
 * Real email notifications, via Resend (https://resend.com).
 *
 * Used for exactly one thing right now: making sure a coaching-call booking
 * is never silently lost. The booking itself is still stored in a plain
 * JSON file on Render's disk (see lib/booking.js), and that disk does NOT
 * survive a restart or redeploy on the free tier — so instead of fixing
 * that with a full database migration right now, every booking fires off
 * an immediate email to Neil, so there's always a durable record
 * somewhere even if the file itself gets wiped. The candidate also gets a
 * real confirmation email — the app used to just claim "a confirmation
 * will follow by email" without ever actually sending one.
 *
 * RESEND_API_KEY and BOOKING_NOTIFY_EMAIL are set in Render's Environment
 * tab, same pattern as every other key in this app. Without RESEND_API_KEY
 * set, both functions below are silent no-ops — a booking still succeeds,
 * it just won't email anyone, so nothing breaks if this isn't configured
 * yet.
 */

function hasEmail() {
  return !!process.env.RESEND_API_KEY;
}

let resendClient = null;
function getResend() {
  if (!hasEmail()) return null;
  if (!resendClient) {
    const { Resend } = require("resend");
    resendClient = new Resend(process.env.RESEND_API_KEY);
  }
  return resendClient;
}

// Resend requires a verified sending domain for a real "from" address —
// until Neil verifies thecommonpeople.co.uk (or another domain) in the
// Resend dashboard, this falls back to their shared onboarding@resend.dev
// sender, which works immediately with no DNS setup but may land in spam
// more often. RESEND_FROM_EMAIL lets that be swapped in later without a
// code change once a domain is verified.
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "The Com'mon People <onboarding@resend.dev>";

// Where booking notifications go. Falls back to BOOKING_NOTIFY_EMAIL if
// set, otherwise there's nowhere safe to guess — Neil needs to set this
// explicitly in Render so it's never accidentally sent to the wrong inbox.
function notifyAddress() {
  return process.env.BOOKING_NOTIFY_EMAIL || null;
}

async function sendBookingNotificationToOwner({ slot, name, email, companyName }) {
  if (!hasEmail()) return;
  const to = notifyAddress();
  if (!to) {
    console.error("[email] BOOKING_NOTIFY_EMAIL isn't set — skipping owner notification for a new booking.");
    return;
  }
  try {
    const resend = getResend();
    await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject: `New coaching call booked — ${name}, ${slot.replace("T", " ")}`,
      html: `
        <p>A new £45 coaching call has been booked.</p>
        <ul>
          <li><b>When:</b> ${slot.replace("T", " ")}</li>
          <li><b>Name:</b> ${name}</li>
          <li><b>Email:</b> ${email}</li>
          <li><b>Company/role:</b> ${companyName || "(not given)"}</li>
        </ul>
      `,
    });
  } catch (err) {
    // Never let an email failure break the booking itself — the candidate
    // already has their slot, this is just the notification layer.
    console.error("[email] could not send owner booking notification:", err.message);
  }
}

async function sendBookingConfirmationToCandidate({ slot, name, email }) {
  if (!hasEmail() || !email) return;
  try {
    const resend = getResend();
    await resend.emails.send({
      from: FROM_EMAIL,
      to: email,
      subject: "Your coaching call is booked — The Com'mon People",
      html: `
        <p>Hi ${name || "there"},</p>
        <p>Your 20-minute coaching call is confirmed for <b>${slot.replace("T", " ")}</b>.</p>
        <p>We'll be in touch beforehand with joining details. If you need to change the time, just reply to this email.</p>
        <p>— The Com'mon People</p>
      `,
    });
  } catch (err) {
    console.error("[email] could not send candidate booking confirmation:", err.message);
  }
}

module.exports = { hasEmail, sendBookingNotificationToOwner, sendBookingConfirmationToCandidate };
