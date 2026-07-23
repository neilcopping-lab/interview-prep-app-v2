/**
 * Stripe Checkout for the £45 Interview Prep Report.
 *
 * Uses Stripe's hosted Checkout page rather than a custom card form —
 * Stripe handles the actual card entry, 3D Secure, and PCI compliance, so
 * this app never sees or touches a real card number. STRIPE_SECRET_KEY is
 * set in Render's Environment tab, same pattern as the Anthropic/OpenAI
 * keys — never in code.
 *
 * Flow: the browser asks this server for a Checkout Session (createCheckoutSession),
 * gets back a Stripe-hosted URL and redirects the whole page there. Stripe
 * sends the candidate back to success_url (with a session ID in the query
 * string) or cancel_url. The server then re-checks that session directly
 * with Stripe (verifyPaidSession) before it will generate a report for it —
 * never trusting a "paid" flag the browser could just claim on its own.
 */

const REPORT_PRICE_GBP = 2500; // £25.00, in pence — Stripe amounts are always the smallest currency unit
const REPORT_PRODUCT_NAME = "The Com'mon People — Interview Prep Report";

function hasStripe() {
  return !!process.env.STRIPE_SECRET_KEY;
}

let stripeClient = null;
function getStripe() {
  if (!hasStripe()) return null;
  if (!stripeClient) {
    const Stripe = require("stripe");
    stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return stripeClient;
}

// origin is passed in per-request (req.protocol + '://' + req.get('host'))
// rather than hardcoded, so this works the same on localhost, the Render
// onrender.com URL, and a future custom domain without a code change.
async function createCheckoutSession({ origin, candidateEmail, companyName }) {
  const stripe = getStripe();
  if (!stripe) return { ok: false, error: "Payment isn't configured yet — add STRIPE_SECRET_KEY in Render's Environment tab." };

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "gbp",
            product_data: {
              name: REPORT_PRODUCT_NAME,
              description: companyName ? `Personalised interview prep report — ${companyName}` : "Personalised interview prep report",
            },
            unit_amount: REPORT_PRICE_GBP,
          },
          quantity: 1,
        },
      ],
      // Stripe replaces the literal {CHECKOUT_SESSION_ID} placeholder itself —
      // don't URL-encode or otherwise touch it.
      success_url: `${origin}/?paid=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?canceled=1`,
      customer_email: candidateEmail || undefined,
    });
    return { ok: true, url: session.url };
  } catch (err) {
    console.error("[payments] could not create checkout session:", err.message);
    return { ok: false, error: "Could not start checkout — please try again in a moment." };
  }
}

// Re-checks a session directly with Stripe rather than trusting anything
// the browser sends back. A session can only be used to unlock ONE report:
// consumedSessions tracks IDs already redeemed so the same paid session
// can't be replayed to generate unlimited reports (e.g. by re-submitting
// the same session_id). This is an in-memory Set, so it resets on a
// server restart/redeploy — acceptable for a low-volume prototype, but
// worth moving to something persistent (see lib/booking.js's same disk
// caveat) if volume grows.
const consumedSessions = new Set();

async function verifyPaidSession(sessionId) {
  if (!sessionId) return { paid: false, error: "No session ID provided." };
  const stripe = getStripe();
  if (!stripe) return { paid: false, error: "Payment isn't configured." };

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== "paid") return { paid: false, error: "This session hasn't been paid yet." };
    if (consumedSessions.has(sessionId)) return { paid: false, error: "This payment has already been used to generate a report." };
    return { paid: true, session };
  } catch (err) {
    console.error("[payments] could not verify session:", err.message);
    return { paid: false, error: "Could not verify payment — please contact support." };
  }
}

function markSessionConsumed(sessionId) {
  if (sessionId) consumedSessions.add(sessionId);
}

module.exports = { hasStripe, createCheckoutSession, verifyPaidSession, markSessionConsumed, REPORT_PRICE_GBP };
