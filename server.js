const path = require("path");
const fs = require("fs");
const express = require("express");
const multer = require("multer");
const mammoth = require("mammoth");
const pdfParse = require("pdf-parse");
const { v4: uuid } = require("uuid");

const OpenAI = require("openai");
const { generateReport } = require("./lib/reportGenerator");
const { buildReportDocx } = require("./lib/docxExport");
const { selectQuestions } = require("./lib/questionBank");
const { getAvailableSlots, bookSlot } = require("./lib/booking");
const { recordConsent } = require("./lib/consent");
const { hasOpenAI, getOpenAI, TRANSCRIBE_MODEL } = require("./lib/aiClients");
const { hasStripe, createCheckoutSession, verifyPaidSession, markSessionConsumed, REPORT_BUNDLES } = require("./lib/payments");
const { getBalance, grantCreditsForSession, consumeCredit } = require("./lib/credits");
const { sendBookingNotificationToOwner, sendBookingConfirmationToCandidate, sendConsentNotificationToOwner, sendCreditNotificationToOwner } = require("./lib/email");

const app = express();

// Git doesn't track empty folders, so a fresh repo upload (or a clean
// clone) can easily arrive without uploads/ even existing — and multer
// doesn't create its destination folder for you, it just errors. Make
// sure it's there on startup rather than depending on it having survived
// the trip through GitHub.
const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Security: cap upload size (10MB) and restrict to the file types the app
// actually handles — rejects anything else before it ever touches disk.
const ALLOWED_UPLOAD_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
]);
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_UPLOAD_TYPES.has(file.mimetype) || file.mimetype.startsWith("audio/")) {
      cb(null, true);
    } else {
      cb(new Error("Unsupported file type"));
    }
  },
});

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

async function extractTextFromFile(filePath, originalName) {
  const name = originalName.toLowerCase();
  if (name.endsWith(".docx")) {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  }
  if (name.endsWith(".pdf")) {
    const buffer = fs.readFileSync(filePath);
    const result = await pdfParse(buffer);
    return result.text;
  }
  // .txt or unknown — read as plain text
  return fs.readFileSync(filePath, "utf8");
}

// -------------------------------------------------------------------------
// File upload -> extracted text. Used for both the CV and the job
// description upload. Supports .docx (mammoth), .pdf (pdf-parse) and .txt.
// Anything else, the frontend falls back to "paste the text instead".
// -------------------------------------------------------------------------
app.post("/api/extract-text", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  try {
    const text = await extractTextFromFile(req.file.path, req.file.originalname);
    res.json({ text: text.trim() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not extract text from that file. Try pasting it instead." });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
});

// Kept for backwards compatibility with the earlier CV-only endpoint.
app.post("/api/extract-cv", upload.single("cv"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  try {
    const text = await extractTextFromFile(req.file.path, req.file.originalname);
    res.json({ text: text.trim() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not extract text from that file. Try pasting your CV instead." });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
});

// -------------------------------------------------------------------------
// Pick competency questions that actually match this job description.
// Live: Claude writes bespoke questions from the JD (lib/questionBank.js).
// Falls back to keyword-matching a fixed question bank if no key / a call
// fails.
// -------------------------------------------------------------------------
app.post("/api/questions", async (req, res) => {
  const { jobDescription, count } = req.body;
  if (!jobDescription || !jobDescription.trim()) {
    return res.status(400).json({ error: "Job description is required to select questions." });
  }
  try {
    const questions = await selectQuestions(jobDescription, count || 5);
    res.json({ questions });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not select questions" });
  }
});

// -------------------------------------------------------------------------
// Transcription. Uses OpenAI's transcription API when OPENAI_API_KEY is
// set; otherwise returns a clear message so the frontend falls back to a
// text box. If the real call fails for any reason (bad key, rate limit,
// network), it degrades the same way rather than erroring out — the
// candidate can always just type instead.
// -------------------------------------------------------------------------
app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  const filePath = req.file && req.file.path;
  if (!hasOpenAI()) {
    if (filePath) fs.unlink(filePath, () => {});
    return res.json({
      text: null,
      message: "Transcription isn't configured yet — add OPENAI_API_KEY in Render's Environment tab. For now, please type your answer.",
    });
  }
  try {
    const client = getOpenAI();
    // Multer writes the upload to disk under a random filename with NO
    // extension, so a raw fs.createReadStream() gives OpenAI no way to
    // tell it's webm/mp4/etc audio and the call gets rejected. Wrapping it
    // with OpenAI.toFile() and passing the browser's original filename
    // (e.g. "answer.webm") back in fixes that — this was the actual bug
    // behind transcription silently "not working."
    const buffer = fs.readFileSync(filePath);
    const uploadFile = await OpenAI.toFile(buffer, req.file.originalname || "answer.webm", {
      type: req.file.mimetype || "audio/webm",
    });
    const transcription = await client.audio.transcriptions.create({
      file: uploadFile,
      model: TRANSCRIBE_MODEL,
    });
    res.json({ text: (transcription.text || "").trim() });
  } catch (err) {
    console.error("[/api/transcribe] falling back:", err.message);
    res.json({ text: null, message: "Transcription hit a problem just now — please type your answer instead." });
  } finally {
    if (filePath) fs.unlink(filePath, () => {});
  }
});

// -------------------------------------------------------------------------
// Shared gate for both /api/report and the "regenerate from scratch" path
// of /api/report/docx below. Report bundles (1/3/5, see lib/payments.js)
// mean a single Stripe payment can unlock more than one report generation,
// so this isn't a one-shot "is this session paid" check any more — there
// are two ways in:
//
//  1. Fresh back from Stripe, with a stripeSessionId: verify it's genuinely
//     paid, then grant that bundle's credits to the candidate's email
//     (idempotent per session — see lib/credits.js — so refreshing the
//     success page can't grant the same bundle twice for free).
//  2. No session at all, just an email that already has credits left from
//     an earlier purchase (report 2 of a 5-pack, or coming back another
//     day) — nothing to verify with Stripe, the balance already proves it
//     was paid for.
//
// Either way this always finishes by spending exactly one credit — that's
// what actually gates generation now, not the Stripe session on its own.
// -------------------------------------------------------------------------
async function ensureReportCredit({ stripeSessionId, candidateEmail }) {
  if (stripeSessionId) {
    const check = await verifyPaidSession(stripeSessionId);
    if (!check.paid) return { ok: false, error: check.error || "Payment required." };
    const email = candidateEmail || (check.session.metadata && check.session.metadata.candidateEmail);
    const creditsInSession = Number((check.session.metadata && check.session.metadata.credits) || 1);
    const grant = grantCreditsForSession({ sessionId: stripeSessionId, email, amount: creditsInSession });
    // Fire-and-forget durable backup — see the comment on this function in
    // lib/email.js. Only fires on the actual grant, not on a re-verify of
    // an already-credited session, so one purchase means one email.
    if (grant.granted) {
      sendCreditNotificationToOwner({ email, credits: creditsInSession, balance: grant.balance, sessionId: stripeSessionId }).catch(() => {});
    }
    markSessionConsumed(stripeSessionId);
    return consumeCredit(email);
  }
  return consumeCredit(candidateEmail);
}

// -------------------------------------------------------------------------
// Generate the report as JSON (used by the frontend to render a preview).
//
// Gated behind ensureReportCredit above rather than a raw Stripe check, so
// bundle purchases (3 or 5 reports) can be spent one at a time. If Stripe
// isn't configured yet (no STRIPE_SECRET_KEY), the gate is skipped entirely
// so local dev and the current prototype keep working without a payment
// setup.
// -------------------------------------------------------------------------
app.post("/api/report", async (req, res) => {
  const { stripeSessionId, candidateEmail } = req.body || {};
  if (hasStripe()) {
    const gate = await ensureReportCredit({ stripeSessionId, candidateEmail });
    if (!gate.ok) return res.status(402).json({ error: gate.error || "Payment required." });
  }
  try {
    const report = await generateReport(req.body);
    res.json(report);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not generate report" });
  }
});

// Lets the frontend check, before showing the £15/£20/£25 paywall, whether
// this email already has report credits left over from an earlier bundle
// purchase — if so it can skip straight to generating the report instead
// of sending the candidate to Stripe to pay again.
app.get("/api/credits/balance", (req, res) => {
  res.json({ balance: getBalance(req.query.email) });
});

// -------------------------------------------------------------------------
// Generate the report and return it as a downloadable .docx.
//
// The frontend auto-downloads the docx immediately after generating the
// on-screen preview (see public/app.js), so if it already has a report
// object from that /api/report call it sends it straight back here as
// { report: {...} } — we build the docx from that instead of paying for
// every AI call (and the OpenAI cover image) a second time. Only
// regenerates from scratch if a report wasn't supplied.
// -------------------------------------------------------------------------
app.post("/api/report/docx", async (req, res) => {
  try {
    // If a report object was already supplied, it came from a /api/report
    // call that already passed the payment gate above — no need to check
    // again, this is just formatting the same paid-for content as a .docx.
    // Only the "regenerate from scratch" path (no report supplied) needs
    // its own check, since it would otherwise let anyone skip the gate by
    // calling this endpoint directly.
    if (!req.body || !req.body.report) {
      const { stripeSessionId, candidateEmail } = req.body || {};
      if (hasStripe()) {
        const gate = await ensureReportCredit({ stripeSessionId, candidateEmail });
        if (!gate.ok) return res.status(402).json({ error: gate.error || "Payment required." });
      }
    }
    const report = req.body && req.body.report ? req.body.report : await generateReport(req.body);
    const buffer = await buildReportDocx(report);
    const filename = `Interview_Prep_${(report.companyName || "report").replace(/[^a-z0-9]/gi, "_")}_${uuid().slice(0, 8)}.docx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not build the document" });
  }
});

// -------------------------------------------------------------------------
// GDPR consent + optional marketing sign-up. Called once, right when the
// candidate moves past the intake step — before any report generation
// happens — so there's a real record of who agreed to the Privacy & Data
// Notice and when, separate from whether they also opted in to future
// marketing (two distinct consents, not bundled into one checkbox).
// -------------------------------------------------------------------------
app.post("/api/consent", (req, res) => {
  const { name, email, companyName, agreedToPrivacy, marketingOptIn } = req.body || {};
  const result = recordConsent({ name, email, companyName, agreedToPrivacy, marketingOptIn });
  if (!result.ok) return res.status(400).json(result);
  // Fire-and-forget durable backup — see the comment on this function in
  // lib/email.js for why: consents.json alone isn't safe against Render's
  // free-tier disk getting wiped on restart/redeploy.
  sendConsentNotificationToOwner(result.record).catch(() => {});
  res.json(result);
});

// -------------------------------------------------------------------------
// PAYMENT — real Stripe Checkout, shared by both paid products. The
// frontend calls this right before report generation (£25) and right
// before confirming a coaching booking (£45), passing `product: "report"`
// or `product: "coaching"` — gets back a Stripe-hosted checkout URL, and
// redirects the whole page there. Falls back to a clear "not configured"
// message if STRIPE_SECRET_KEY isn't set yet, rather than erroring out.
// -------------------------------------------------------------------------
app.post("/api/checkout", async (req, res) => {
  if (!hasStripe()) {
    return res.json({
      url: null,
      message: "Payment isn't configured yet — add STRIPE_SECRET_KEY in Render's Environment tab. See README.md.",
    });
  }
  const origin = `${req.protocol}://${req.get("host")}`;
  const { candidateEmail, companyName, product } = req.body || {};
  const result = await createCheckoutSession({ origin, candidateEmail, companyName, product });
  if (!result.ok) return res.status(500).json({ url: null, message: result.error });
  res.json({ url: result.url });
});

// Called by the frontend right after Stripe redirects back, to confirm the
// session actually shows as paid before generating anything. Kept as a
// separate check (rather than only checking inside /api/report) so the
// frontend can show a clear "payment confirmed" state immediately on
// return, before kicking off the (much longer) report generation call.
app.get("/api/checkout/verify", async (req, res) => {
  const result = await verifyPaidSession(req.query.session_id);
  res.json(result);
});

// -------------------------------------------------------------------------
// COACHING ADD-ON BOOKING (£45) — real slot generation and double-booking
// prevention, now gated behind a confirmed paid Stripe session (same
// pattern as /api/report) and followed by real emails: one to Neil so a
// booking is never silently lost even though the underlying storage is
// just a file on Render's disk (see lib/booking.js), and a real
// confirmation to the candidate — the app used to just claim one would
// arrive without ever actually sending it.
// -------------------------------------------------------------------------
app.get("/api/booking/slots", (req, res) => {
  res.json({ slots: getAvailableSlots() });
});

app.post("/api/booking/book", async (req, res) => {
  const { slot, name, email, companyName, stripeSessionId } = req.body || {};
  if (!slot || !name || !email) {
    return res.status(400).json({ error: "Slot, name and email are required." });
  }
  if (hasStripe()) {
    const check = await verifyPaidSession(stripeSessionId);
    if (!check.paid) return res.status(402).json({ error: check.error || "Payment required." });
    markSessionConsumed(stripeSessionId);
  }
  const result = bookSlot({ slot, name, email, companyName });
  if (!result.ok) return res.status(409).json(result);
  // Best-effort — a booking is already confirmed and saved at this point;
  // an email hiccup shouldn't turn that into an error for the candidate.
  sendBookingNotificationToOwner({ slot, name, email, companyName }).catch(() => {});
  sendBookingConfirmationToCandidate({ slot, name, email }).catch(() => {});
  res.json(result);
});

// Catch multer errors (oversized or wrong-type uploads) with a clean JSON
// response instead of a raw stack trace.
app.use((err, req, res, next) => {
  if (err && err.message) {
    console.error(err);
    return res.status(400).json({ error: err.message === "Unsupported file type" ? err.message : "That file couldn't be uploaded — check it's under 10MB and a PDF, Word doc or text file." });
  }
  next(err);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Interview prep app running on http://localhost:${PORT}`));
