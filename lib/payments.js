/**
 * Stripe Checkout for the one paid product: the optional £45 coaching call.
 * Interview Prep reports themselves are free.
 *
 * Uses Stripe's hosted Checkout page rather than a custom card form —
 * Stripe handles the actual card entry, 3D Secure, and PCI compliance, so
 * this app never sees or touches a real card number. STRIPE_SECRET_KEY is
 * set in Render's Environment tab, same pattern as the Anthropic/OpenAI
 * keys — never in code.
 *
 * Flow: the browser asks this server for a Checkout Session (createCheckoutSession),
 * gets back a Stripe-hosted URL and redirects the whole page there. Stripe
 * sends the candidate back to success_url (with a session ID and which
 * product it was for in the query string) or cancel_url. The server then
 * re-checks that session directly with Stripe (verifyPaidSession) before it
 * will generate a report or confirm a booking for it — never trusting a
 * "paid" flag the browser could just claim on its own.
 */

// Interview Prep reports are free (28 Nov 2026): no report prices, no report
// bundles and no promo codes. The only thing that can still be paid for is
// the optional coaching call. REPORT_BUNDLES stays exported, empty, so
// older code that imports it doesn't break.
const REPORT_BUNDLES = {};
const COACHING_PRICE_GBP = 4500; // £45.00, in pence

// The coaching call is the only paid product. Anything else asked for
// (for example an old cached page still sending "report_1") is refused,
// because reports are free.
const PRODUCTS = {
  coaching: {
    priceGbp: COACHING_PRICE_GBP,
    credits: 0,
    name: "Comquat Interview Prep: Coaching Call",
    describe: () => "30-minute coaching call, tailored to your interview prep report",
  },
};

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
// `product` selects which of PRODUCTS above this checkout is for — the
// success_url carries it back through as `type` so the frontend knows
// whether it's returning from paying for a report or a coaching booking.
async function createCheckoutSession({ origin, candidateEmail, companyName, product = "coaching" }) {
  const stripe = getStripe();
  if (!stripe) return { ok: false, error: "Payment isn't configured yet. Add STRIPE_SECRET_KEY in Render's Environment tab." };
  const config = PRODUCTS[product];
  if (!config) return { ok: false, error: "Interview Prep reports are free, so there's nothing to pay for." };

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      // No promo code box on checkout (28 Nov 2026). Reports are free, so
      // the old TRY4FREE code has nothing left to do.
      allow_promotion_codes: false,
      line_items: [
        {
          price_data: {
            currency: "gbp",
            product_data: {
              name: config.name,
              description: config.describe(companyName),
            },
            unit_amount: config.priceGbp,
          },
          quantity: 1,
        },
      ],
      // Stripe replaces the literal {CHECKOUT_SESSION_ID} placeholder itself —
      // don't URL-encode or otherwise touch it.
      success_url: `${origin}/?paid=1&type=${product}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?canceled=1&type=${product}`,
      customer_email: candidateEmail || undefined,
      // Recorded so the caller (server.js) knows how many report credits to
      // grant once this session comes back paid, and to which email —
      // Stripe's own session metadata is the one place this survives the
      // full-page redirect to Stripe's checkout and back, so no separate
      // lookup is needed. See lib/credits.js for how these get spent.
      metadata: {
        product,
        credits: String(config.credits || 0),
        candidateEmail: candidateEmail || "",
      },
    });
    return { ok: true, url: session.url };
  } catch (err) {
    console.error("[payments] could not create checkout session:", err.message);
    return { ok: false, error: "Could not start checkout. Please try again in a moment." };
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
    return { paid: false, error: "Could not verify payment. Please contact support." };
  }
}

function markSessionConsumed(sessionId) {
  if (sessionId) consumedSessions.add(sessionId);
}

module.exports = { hasStripe, createCheckoutSession, verifyPaidSession, markSessionConsumed, REPORT_BUNDLES, COACHING_PRICE_GBP };
