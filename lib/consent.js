/**
 * GDPR consent + optional marketing sign-up capture.
 *
 * Records that a candidate agreed to the Privacy & Data Notice before a
 * report was generated (name, email, timestamp), plus whether they opted
 * in to future communications — kept separate from that agreement, since
 * under UK GDPR/PECR consent to process data for the service itself and
 * consent to marketing are two different things and must not be bundled
 * into a single checkbox.
 *
 * ⚠️ Storage: same pattern as lib/booking.js — a plain JSON file on local
 * disk (data/consents.json). On Render's free tier, local disk does NOT
 * persist across restarts/redeploys, so this is fine for testing but
 * should move to a real database (or at minimum Render's paid persistent
 * disk) before this is relied on for real compliance record-keeping.
 */

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "consents.json");

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ consents: [] }, null, 2));
}

function readConsents() {
  ensureStore();
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.consents) ? parsed.consents : [];
  } catch (err) {
    console.error("[consent] could not read store, treating as empty:", err.message);
    return [];
  }
}

function writeConsents(consents) {
  ensureStore();
  fs.writeFileSync(DATA_FILE, JSON.stringify({ consents }, null, 2));
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The privacy agreement is mandatory (can't generate a report without it —
// enforced both client-side in app.js and here, since the client check
// alone can always be bypassed). The marketing opt-in is genuinely
// optional and defaults to false if not explicitly passed as true.
function recordConsent({ name, email, companyName, agreedToPrivacy, marketingOptIn }) {
  if (!email || !EMAIL_PATTERN.test(email)) {
    return { ok: false, error: "A valid email address is required." };
  }
  if (!agreedToPrivacy) {
    return { ok: false, error: "You must agree to the Privacy & Data Notice to continue." };
  }

  const record = {
    name: name || null,
    email,
    companyName: companyName || null,
    agreedToPrivacy: true,
    marketingOptIn: !!marketingOptIn,
    recordedAt: new Date().toISOString(),
  };

  const consents = readConsents();
  consents.push(record);
  writeConsents(consents);

  return { ok: true, record };
}

module.exports = { recordConsent, readConsents };
