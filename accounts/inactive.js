// Closing Comquat accounts that haven't been used for three years.
//
// The privacy notice promises: "If you don't sign in for three years, we'll
// email you a month before closing your account, and then delete it."
//
//   * "Used" means the latest of: when the account was made, the last sign-in,
//     and the last day the person used CV Rewrite or Interview Prep while
//     signed in (recorded once a day by touch()).
//   * At three years less 30 days we send a warning email and note the date.
//   * If they come back, the warning is cleared and the clock starts again.
//   * At least 30 days after the warning, and three years after their last
//     use, the account is closed: saved documents, then email choices, then
//     the account itself, and a short "your account has closed" email.
//
// Safety catches, because a mistake here can't be undone:
//   * INACTIVE_ACCOUNTS=off stops everything, =warn-only sends warnings but
//     never closes anything. Anything else means on.
//   * Nobody is closed without a warning sent at least 30 days earlier.
//   * No more than 50 closures in one run, and none at all if a run would
//     close more than a fifth of all accounts (that would point to a bug).

const DAY = 24 * 60 * 60 * 1000;
const CLOSE_AFTER = 3 * 365 * DAY;
const NOTICE = 30 * DAY;
const WARN_AFTER = CLOSE_AFTER - NOTICE;
const MAX_CLOSE_PER_RUN = 50;
const MAX_CLOSE_SHARE = 0.2;

const ACCOUNT_URL = "https://cv.the-common-people.com/account/";
const SIGNUP_URL = "https://cv.the-common-people.com/account/?mode=signup";

const mode = () => String(process.env.INACTIVE_ACCOUNTS || "on").trim().toLowerCase();
const ts = (v) => (v ? new Date(v).getTime() : 0);
const ukDate = (ms) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London" });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---- the emails -------------------------------------------------------------------
function shell(inner) {
  return `<div style="background:#FFF3E2;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;color:#17191C">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #E9DCC8;border-radius:16px;padding:32px">
    <p style="margin:0 0 24px;font-size:22px;font-weight:bold;letter-spacing:-0.5px">comquat <span style="font-size:11px;letter-spacing:2px;background:#17191C;color:#FFF3E2;padding:4px 10px;border-radius:99px;vertical-align:middle">ACCOUNT</span></p>
    ${inner}
    <p style="font-size:13px;line-height:1.5;color:#5B5F66;margin:24px 0 0;border-top:1px solid #E9DCC8;padding-top:16px">Comquat is part of The Com'mon People, run by Comquat Ventures UK Ltd. You're getting this because you have a Comquat account with this email address.</p>
  </div>
</div>`;
}
const P = (t) => `<p style="font-size:16px;line-height:1.55;margin:0 0 16px">${t}</p>`;

function warningEmail(name, closeOn) {
  const hi = name ? `Hi ${esc(name.split(/\s+/)[0])},` : "Hi,";
  const date = ukDate(closeOn);
  return {
    subject: `Your Comquat account will close on ${date}`,
    html: shell(
      `<h1 style="font-size:24px;line-height:1.2;margin:0 0 14px">We haven't seen you for a while</h1>` +
      P(hi) +
      P(`It's been nearly three years since you last used your Comquat account. We don't hang on to people's details for longer than we need to, so we close accounts that haven't been used for three years.`) +
      P(`Yours will close on <strong>${date}</strong>, and everything in it will be deleted, including your master CV and any saved CVs, cover letters and prep reports.`) +
      P(`<strong>Want to keep it?</strong> Just sign in before then and it stays open. That's all you need to do.`) +
      `<p style="margin:8px 0 24px"><a href="${ACCOUNT_URL}" style="display:inline-block;background:#1F6B45;color:#FFF3E2;text-decoration:none;font-weight:bold;font-size:16px;padding:13px 24px;border-radius:6px">Sign in and keep my account</a></p>` +
      P(`<strong>Happy for it to go?</strong> You don't need to do anything. If you'd like a copy of your documents first, sign in and use Download my data on your account page.`)
    ),
    text:
      `${hi}\n\nIt's been nearly three years since you last used your Comquat account. We don't hang on to people's details for longer than we need to, so we close accounts that haven't been used for three years.\n\n` +
      `Yours will close on ${date}, and everything in it will be deleted, including your master CV and any saved CVs, cover letters and prep reports.\n\n` +
      `Want to keep it? Just sign in before then and it stays open: ${ACCOUNT_URL}\n\n` +
      `Happy for it to go? You don't need to do anything. If you'd like a copy of your documents first, sign in and use Download my data on your account page.\n\n` +
      `Comquat is part of The Com'mon People, run by Comquat Ventures UK Ltd.`,
  };
}

function closedEmail(name) {
  const hi = name ? `Hi ${esc(name.split(/\s+/)[0])},` : "Hi,";
  return {
    subject: "Your Comquat account has been closed",
    html: shell(
      `<h1 style="font-size:24px;line-height:1.2;margin:0 0 14px">Your account has been closed</h1>` +
      P(hi) +
      P(`As we said in our email last month, your Comquat account hadn't been used for three years, so we've closed it and deleted everything in it, including your master CV and saved documents. We've also taken you off the Comquat emails you'd ticked.`) +
      P(`You're always welcome back. You can make a new free account whenever you like.`) +
      `<p style="margin:8px 0 8px"><a href="${SIGNUP_URL}" style="display:inline-block;background:#1F6B45;color:#FFF3E2;text-decoration:none;font-weight:bold;font-size:16px;padding:13px 24px;border-radius:6px">Make a new account</a></p>`
    ),
    text:
      `${hi}\n\nAs we said in our email last month, your Comquat account hadn't been used for three years, so we've closed it and deleted everything in it, including your master CV and saved documents. We've also taken you off the Comquat emails you'd ticked.\n\n` +
      `You're always welcome back. You can make a new free account whenever you like: ${SIGNUP_URL}\n\nComquat is part of The Com'mon People, run by Comquat Ventures UK Ltd.`,
  };
}

async function sendViaResend(to, msg) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("no RESEND_API_KEY");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.ACCOUNT_EMAIL_FROM || process.env.RESEND_FROM || "Comquat <cv@the-common-people.com>",
      to: [to], subject: msg.subject, html: msg.html, text: msg.text,
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
}

// ---- recording use -------------------------------------------------------------
// Called on every signed-in request; writes at most once a day per person.
const lastTouch = new Map();
function touch(admin, userId, now = Date.now()) {
  if (!admin || !userId) return;
  if (now - (lastTouch.get(userId) || 0) < DAY) return;
  lastTouch.set(userId, now);
  admin.from("profiles").update({ last_seen_at: new Date(now).toISOString(), inactivity_warned_at: null }).eq("id", userId)
    .then(({ error }) => { if (error) { lastTouch.delete(userId); console.error("[inactive] touch:", error.message); } })
    .catch(() => lastTouch.delete(userId));
}

// ---- one pass ---------------------------------------------------------------------
async function listAllUsers(admin) {
  const users = [];
  for (let page = 1; page < 200; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(error.message);
    const batch = (data && data.users) || [];
    users.push(...batch);
    if (batch.length < 1000) break;
  }
  return users;
}

// deps: { admin, now, send(to, msg), closeAccount(user) }
async function runOnce(deps) {
  const m = mode();
  const out = { mode: m, accounts: 0, warned: 0, cleared: 0, closed: 0, skipped: [] };
  if (m === "off") return out;
  const { admin } = deps;
  const now = deps.now || Date.now();

  const users = await listAllUsers(admin);
  out.accounts = users.length;
  if (!users.length) return out;
  const { data: profiles, error } = await admin.from("profiles").select("id, full_name, last_seen_at, inactivity_warned_at");
  if (error) throw new Error(error.message);
  const byId = new Map((profiles || []).map((p) => [p.id, p]));

  const toWarn = [], toClose = [];
  for (const u of users) {
    if (!u.email) continue;
    const p = byId.get(u.id) || {};
    const lastUse = Math.max(ts(u.created_at), ts(u.last_sign_in_at), ts(p.last_seen_at));
    const warnedAt = ts(p.inactivity_warned_at);
    if (warnedAt && lastUse > warnedAt) {
      // They came back after we warned them: start the clock again.
      await admin.from("profiles").update({ inactivity_warned_at: null }).eq("id", u.id);
      out.cleared++;
      continue;
    }
    if (!warnedAt && now - lastUse >= WARN_AFTER) toWarn.push({ u, p, lastUse });
    else if (warnedAt && now - warnedAt >= NOTICE && now - lastUse >= CLOSE_AFTER) toClose.push({ u, p });
  }

  for (const { u, p, lastUse } of toWarn) {
    // Always give at least a full month's notice from the day the email goes.
    const closeOn = Math.max(lastUse + CLOSE_AFTER, now + NOTICE);
    try {
      await deps.send(u.email, warningEmail(p.full_name || "", closeOn));
      const { error: e } = await admin.from("profiles").upsert({ id: u.id, inactivity_warned_at: new Date(now).toISOString() });
      if (e) throw new Error(e.message);
      out.warned++;
    } catch (e) {
      console.error("[inactive] warning failed:", e.message);
      out.skipped.push("warn-failed");
    }
  }

  if (m === "warn-only") { if (toClose.length) out.skipped.push(`warn-only: ${toClose.length} not closed`); return out; }
  if (toClose.length > MAX_CLOSE_PER_RUN || toClose.length > Math.max(1, users.length * MAX_CLOSE_SHARE)) {
    console.error(`[inactive] refusing to close ${toClose.length} of ${users.length} accounts in one run; check before switching back on`);
    out.skipped.push(`too-many: ${toClose.length}`);
    return out;
  }
  for (const { u, p } of toClose) {
    try {
      await deps.closeAccount(u);
      out.closed++;
      deps.send(u.email, closedEmail(p.full_name || "")).catch((e) => console.error("[inactive] closed email:", e.message));
    } catch (e) {
      console.error("[inactive] close failed:", e.message);
      out.skipped.push("close-failed");
    }
  }
  return out;
}

// ---- the schedule ---------------------------------------------------------------
// Started by one app only (CV Rewrite). First pass ten minutes after start-up,
// then every twelve hours. Everything it does is safe to repeat.
function start({ admin, closeAccount, send = sendViaResend, firstRunMs = 10 * 60 * 1000, everyMs = 12 * 60 * 60 * 1000 }) {
  if (!admin || mode() === "off") return null;
  const run = () => runOnce({ admin, closeAccount, send })
    .then((r) => { if (r.warned || r.closed || r.cleared || r.skipped.length) console.log("[inactive]", JSON.stringify(r)); })
    .catch((e) => console.error("[inactive] run failed:", e.message));
  const first = setTimeout(run, firstRunMs);
  const every = setInterval(run, everyMs);
  first.unref && first.unref();
  every.unref && every.unref();
  return { stop: () => { clearTimeout(first); clearInterval(every); } };
}

module.exports = { runOnce, start, touch, warningEmail, closedEmail, DAY, CLOSE_AFTER, WARN_AFTER, NOTICE };
