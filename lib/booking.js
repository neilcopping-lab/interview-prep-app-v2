/**
 * Coaching add-on (£29) slot booking. Real availability generation and
 * double-booking prevention — no payment gate yet (see README/server.js).
 *
 * ⚠️ Storage: bookings are stored in a plain JSON file on local disk
 * (data/bookings.json). On Render's free tier, local disk does NOT
 * persist across restarts or redeploys — bookings could be silently
 * lost. Move to Render's paid persistent disk, or better, a real
 * database, before this goes live for real customers.
 */

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "bookings.json");

// Monday=1 ... Thursday=4 (matches JS Date#getDay()).
const WEEKLY_AVAILABILITY = [
  { day: 1, start: "18:00", end: "20:00" },
  { day: 2, start: "18:00", end: "20:00" },
  { day: 3, start: "18:00", end: "20:00" },
  { day: 4, start: "18:00", end: "20:00" },
];

const SLOT_MINUTES = 20;
const DAYS_AHEAD = 14;

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ bookings: [] }, null, 2));
}

function readBookings() {
  ensureStore();
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.bookings) ? parsed.bookings : [];
  } catch (err) {
    console.error("[booking] could not read store, treating as empty:", err.message);
    return [];
  }
}

function writeBookings(bookings) {
  ensureStore();
  fs.writeFileSync(DATA_FILE, JSON.stringify({ bookings }, null, 2));
}

function pad(n) {
  return String(n).padStart(2, "0");
}

// Every bookable 20-minute slot over the next DAYS_AHEAD days, on the
// days/hours defined in WEEKLY_AVAILABILITY. Each slot is an ISO-ish
// local timestamp string, used as both its unique ID and its display
// value — e.g. "2026-07-27T18:00".
function generateSlots() {
  const slots = [];
  const now = new Date();

  for (let offset = 0; offset < DAYS_AHEAD; offset++) {
    const day = new Date(now);
    day.setDate(day.getDate() + offset);
    day.setHours(0, 0, 0, 0);

    const availability = WEEKLY_AVAILABILITY.find((a) => a.day === day.getDay());
    if (!availability) continue;

    const [startH, startM] = availability.start.split(":").map(Number);
    const [endH, endM] = availability.end.split(":").map(Number);

    const slotStart = new Date(day);
    slotStart.setHours(startH, startM, 0, 0);
    const slotEnd = new Date(day);
    slotEnd.setHours(endH, endM, 0, 0);

    for (let t = new Date(slotStart); t < slotEnd; t.setMinutes(t.getMinutes() + SLOT_MINUTES)) {
      // Skip slots already in the past (relevant for "today" only).
      if (t <= now) continue;
      const iso = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}`;
      slots.push(iso);
    }
  }

  return slots;
}

// All generated slots minus any that are already booked.
function getAvailableSlots() {
  const bookings = readBookings();
  const bookedSlots = new Set(bookings.map((b) => b.slot));
  return generateSlots().filter((slot) => !bookedSlots.has(slot));
}

// Books a slot, guarding against two problems: (1) someone posting a slot
// that isn't actually one of the currently-generated valid slots, and
// (2) two people booking the same slot in a race (re-checked against the
// freshest read of the store right before writing).
function bookSlot({ slot, name, email, companyName }) {
  if (!slot || !name || !email) {
    return { ok: false, error: "Slot, name and email are required." };
  }

  const validSlots = new Set(generateSlots());
  if (!validSlots.has(slot)) {
    return { ok: false, error: "That slot isn't available — please pick another time." };
  }

  const bookings = readBookings();
  if (bookings.some((b) => b.slot === slot)) {
    return { ok: false, error: "Sorry, that slot was just booked by someone else — please pick another time." };
  }

  const booking = {
    slot,
    name,
    email,
    companyName: companyName || null,
    bookedAt: new Date().toISOString(),
  };
  bookings.push(booking);
  writeBookings(bookings);

  return { ok: true, booking };
}

module.exports = { getAvailableSlots, bookSlot, generateSlots, WEEKLY_AVAILABILITY, SLOT_MINUTES, DAYS_AHEAD };
