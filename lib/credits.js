/**
 * Report credit balances — lets one Stripe purchase (the 1, 3, or 5-report
 * bundle from lib/payments.js) be spent across several separate report
 * generations, possibly on different days, instead of being tied to the one
 * Stripe Checkout Session ID the old single-report flow used.
 *
 * Keyed by email rather than session ID: Stripe's session_id only lives in
 * the URL for the one redirect straight back from Checkout (see
 * public/app.js's handleCheckoutReturn, which strips it from the address
 * bar immediately) — there's nothing left to look a session back up by on a
 * later visit. Email is what the candidate already gives us at Step 1, so
 * it doubles as the credit-balance key with no login system needed.
 *
 * ⚠️ Storage: same pattern (and same caveat) as lib/booking.js and
 * lib/consent.js — a plain JSON file on local disk (data/credits.json).
 * Does NOT survive a restart/redeploy on Render's free tier. This is the
 * one of the three data files where that caveat matters most commercially:
 * losing it mid-use means a candidate who paid for 5 reports and used 2
 * could silently lose the other 3. Move this to a real database before
 * relying on it for paying customers — see the email/database notes given
 * alongside this change.
 */

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "credits.json");

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ balances: {}, creditedSessions: [] }, null, 2));
  }
}

function readStore() {
  ensureStore();
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      balances: parsed.balances && typeof parsed.balances === "object" ? parsed.balances : {},
      creditedSessions: Array.isArray(parsed.creditedSessions) ? parsed.creditedSessions : [],
    };
  } catch (err) {
    console.error("[credits] could not read store, treating as empty:", err.message);
    return { balances: {}, creditedSessions: [] };
  }
}

function writeStore(store) {
  ensureStore();
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

function normaliseEmail(email) {
  return (email || "").trim().toLowerCase();
}

// How many reports this email has left to redeem, from any past purchase.
function getBalance(email) {
  const key = normaliseEmail(email);
  if (!key) return 0;
  const store = readStore();
  return store.balances[key] || 0;
}

// Adds `amount` credits to `email` — but only once per Stripe session, so a
// refresh of the success page (which re-runs the verify call in
// handleCheckoutReturn) can't grant the same bundle's credits twice for
// free. Call this once, right after verifyPaidSession confirms a report
// session is genuinely paid.
function grantCreditsForSession({ sessionId, email, amount }) {
  const key = normaliseEmail(email);
  if (!key || !sessionId || !amount) return { granted: false };
  const store = readStore();
  if (store.creditedSessions.includes(sessionId)) {
    return { granted: false, alreadyCredited: true, balance: store.balances[key] || 0 };
  }

  store.balances[key] = (store.balances[key] || 0) + amount;
  store.creditedSessions.push(sessionId);
  writeStore(store);
  return { granted: true, balance: store.balances[key] };
}

// Spends one credit for `email`. The caller (server.js's /api/report route)
// treats ok:false the same as "payment required" and sends the candidate
// back to checkout — this is what actually gates report generation now,
// not a one-shot Stripe session check.
function consumeCredit(email) {
  const key = normaliseEmail(email);
  if (!key) return { ok: false, error: "An email address is required to check report credits." };
  const store = readStore();
  const balance = store.balances[key] || 0;
  if (balance < 1) return { ok: false, error: "No report credits remaining — please purchase another report." };
  store.balances[key] = balance - 1;
  writeStore(store);
  return { ok: true, remaining: store.balances[key] };
}

module.exports = { getBalance, grantCreditsForSession, consumeCredit };
