# The Com'mon People — Interview Prep Report (prototype)

A working prototype of the £25 automated interview prep report concept: paste a job
description and CV, answer a handful of competency questions (by voice or text), and
generate a personalised report — previewed on screen and downloadable as a `.docx`.

This is deliberately built as a **standalone app**, not bolted onto the static
`the-common-people.com` site. Link out to it from the site (e.g. a "Get your
personalised interview prep report" button) once it's hosted somewhere with a URL.

## Run it locally

```bash
cd interview-prep-app
npm install
node server.js
```

Then open `http://localhost:3000`.

## What's real vs. what's a placeholder

This app is fully functional end to end, and the report-writing AI calls are live
(not placeholders) whenever `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are set in the
environment. Without those keys set, everything still works — it just falls back to
rule-based prototype logic instead of erroring out. The same fallback also kicks in
automatically if a real API call fails for any reason (bad key, rate limit, network
blip), so a paying customer should never see a broken report.

Payment is the one piece still fully stubbed out:

| Feature | Status | To go live |
|---|---|---|
| Intake form, CV **and** JD upload/parsing (.pdf/.docx/.txt) | ✅ Working | — |
| Competency questions matched to the job description | ✅ Live — Claude writes 5 bespoke questions from the actual JD text when `ANTHROPIC_API_KEY` is set. Falls back to keyword-matching a 16-question bank (`lib/questionBank.js`) if the key's missing or the call fails. | — |
| STAR "how to answer" explainer, in-app and in the report | ✅ Working | — |
| Audio recording in the browser | ✅ Working | — |
| Speech-to-text transcription | ✅ Live — uses OpenAI's transcription API when `OPENAI_API_KEY` is set | — |
| Company overview (deep-dive: size, structure, products, culture, leadership, trajectory, competitors) | ✅ Live — real Claude call with web search enabled when `ANTHROPIC_API_KEY` is set | — |
| Recent news & press mentions | ✅ Live — web-search-grounded, with real source links shown under the section | — |
| Employee sentiment (Glassdoor/Google/Indeed themes) | ✅ Live — web-search-grounded, with real source links shown under the section | — |
| Social media presence + recent activity | ✅ Live — web-search-grounded, with real source links shown under the section | — |
| Market & sector intelligence | ✅ Live — web-search-grounded, with real source links shown under the section | — |
| Challenges you may face in the role (labour/skills shortages, sector pressure) | ✅ Live — web-search-grounded, with real source links shown under the section | — |
| Cited sources on researched sections | ✅ Live — every web-search-backed section shows its real source URLs (not just "trust me") | — |
| Pitch "Fit" summary | ✅ Live — written from the candidate's actual CV, weighted to the JD | — |
| STAR answer drafting | ✅ Live — Claude restructures the real transcript into clean S/T/A/R | — |
| Gap analysis (JD vs CV) | ✅ Live — Claude reasons about genuine gaps (e.g. "Canva" as an adjacent skill to "Adobe"), not just missing keywords | — |
| Skills-match visual | ✅ Live — a % bar showing matched vs. gap requirements, alongside the full Cake + Cherry bullet analysis | — |
| Personalised AI cover art | ✅ Live — an abstract, on-brand image generated per report (via OpenAI's image API) with the candidate's name and company overlaid in real text, when `OPENAI_API_KEY` is set. Deliberately abstract, not a literal (and inevitably inaccurate) attempt at the real company's building/logo. | — |
| Payment (£25 report) | ✅ Live — real Stripe Checkout when `STRIPE_SECRET_KEY` is set. Candidate is redirected to Stripe's hosted checkout, then straight back; `/api/report` and `/api/report/docx` re-verify the session is genuinely paid directly with Stripe before generating anything. Without the key set, falls back to generating for free (so local dev/testing still works). | Add `STRIPE_SECRET_KEY` in Render's Environment tab — see the Stripe setup section below |
| Docx export | ✅ Working, auto-downloads the moment the report finishes generating | — |
| Visual design | ✅ Matched to the-common-people.com (Anton/Oswald/Arvo fonts, navy/mustard/sky-blue/orange palette pulled from the live site) | — |
| Coaching call add-on (£45) | ✅ Real booking system (`lib/booking.js`) generates genuine availability and prevents double-booking, gated behind the same Stripe Checkout pattern as the report, and now sends real emails on a successful booking (see below) | — |
| Booking/report notification emails | ✅ Live — via Resend (`lib/email.js`) when `RESEND_API_KEY` is set. Every coaching booking emails both Neil (`BOOKING_NOTIFY_EMAIL`) and the candidate a real confirmation. Without the key set, bookings still work, they just don't email anyone. | Add `RESEND_API_KEY` and `BOOKING_NOTIFY_EMAIL` — see the Resend setup section below |
| Privacy & data notice | ✅ Draft published at `/privacy.html`, linked from the app | Have this reviewed properly (by a solicitor if budget allows) before real users' data flows through it |

## ⚠️ Before relying on this at real volume

- **Booking/consent storage is not production-safe yet.** `lib/booking.js` and
  `lib/consent.js` store their records in plain JSON files on local disk. On Render's
  free tier, local disk does **not** persist across restarts or redeploys — those
  records could be silently lost. The email notification on every booking (see above)
  is a safety net against that for bookings specifically — Neil gets a real email the
  moment someone books, so it isn't only sitting in a file that could vanish — but it's
  still worth moving to Render's paid persistent disk, or better, a real database,
  before relying on this at real volume.
- **A Stripe session can currently only be "spent" once in memory.** `lib/payments.js`
  tracks used sessions in a plain in-memory `Set`, which resets on every server
  restart/redeploy. Fine for a low-volume prototype; move to something persistent
  (same caveat as the booking/consent JSON files below) if this needs to be airtight.
- **Uploads are validated but not scanned.** File size is capped at 10MB and type is
  restricted to PDF/Word/text/audio server-side, but there's no malware scanning. Low
  risk at this scale, worth revisiting if volume grows.
- **A report now costs a bit more in API usage than earlier versions.** Each report
  involves ~9 AI calls (5 of them Claude web-search calls, plus one OpenAI image
  generation for the cover art) instead of the original ~4. Still trivial against the £25
  price, but worth knowing when you're checking margins. One inefficiency is already
  fixed: the app used to regenerate the *entire* report a second time just to build the
  downloadable .docx (since it auto-downloads immediately after the on-screen preview) —
  it now reuses the report it already generated, so you're not paying for every AI call
  (and the image) twice per customer.

## How to tell it's really using AI

Once both keys are set in Render, generate a report and check the status line under the
report preview — it'll say "(AI-powered)" instead of "(prototype mode)". The company
overview section is the clearest tell: instead of the bracketed `[AI UPGRADE POINT...]`
placeholder text, you'll see real, specific bullet points about the actual company. If
keys are set but you still see placeholder text, check Render's logs — the app logs a
`falling back: ...` line with the real error whenever a live call fails (bad key, out of
credit, rate limited, etc.) rather than failing silently.

## Setting up Stripe (£25 report payment)

1. Create a free account at [stripe.com](https://stripe.com) if you don't have one.
2. Get into a test environment before touching real money. Older accounts have a
   simple **Test mode** toggle near the top-left. Newer accounts instead default to
   **Sandboxes** — click your business name (top-left) → **Switch to sandbox** →
   open the sandbox Stripe created for you automatically. Either way, you end up
   somewhere that only accepts fake test cards.
3. Go to **Developers → API keys** and copy the **Secret key** (starts `sk_test_...`
   whether you're in test mode or a sandbox; `sk_live_...` once you switch to your
   real, live account).
4. In Render: your service → **Environment** tab → add a new variable named
   `STRIPE_SECRET_KEY` with that value → save (Render redeploys automatically).
5. Test it: run through the app, and on the "Pay & generate my report" step you should
   land on a real Stripe checkout page. Use Stripe's test card `4242 4242 4242 4242`,
   any future expiry date, any 3-digit CVC, any postcode — it'll complete as a
   successful test payment and bring you straight back to your generated report.
6. When you're ready to take real payments, switch to your main **Live** account,
   copy the live secret key (`sk_live_...`) from the same API keys page, and replace
   the value in Render's Environment tab with it. That's the only change needed to
   go from test to real payments.

## Setting up Resend (booking notification + confirmation emails)

1. Create a free account at [resend.com](https://resend.com).
2. Go to **API Keys** in the Resend dashboard, create a key, and copy it.
3. In Render: your service → **Environment** tab → add `RESEND_API_KEY` with that
   value, and add a second variable `BOOKING_NOTIFY_EMAIL` set to whichever inbox you
   want new-booking alerts sent to (e.g. your own address) → save.
4. That's enough to work immediately — emails will send from Resend's shared
   `onboarding@resend.dev` address, which needs no setup but may land in spam more
   often. To send from your own address instead (e.g. `bookings@thecommonpeople.co.uk`),
   verify that domain under **Domains** in Resend (it'll give you DNS records to add
   in Cloudflare, same place you manage the site's other DNS), then set a third
   variable, `RESEND_FROM_EMAIL`, to something like
   `The Com'mon People <bookings@thecommonpeople.co.uk>`.
5. Test it: book a coaching slot through the app (with a real email address of your
   own) and confirm both the candidate-side confirmation and your own notification
   actually arrive.

## Next steps to go live

1. ✅ ~~Add `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`~~ — done, report generation and
   transcription are live.
2. ✅ ~~Add `STRIPE_SECRET_KEY`, wire up a real Checkout session, gate report and
   coaching booking generation~~ — done for both the £25 report and the £45 coaching
   add-on (see the setup steps above).
3. ✅ ~~Add real email notifications so a booking is never silently lost~~ — done via
   Resend (see the setup steps above).
4. Review the privacy notice at `/privacy.html` (draft included) and get it properly
   checked before real users' data flows through the app — see the Legal, Data and
   Trust section of the concept document for the full list of what needs covering.
5. Move booking storage, consent records, and the Stripe used-session tracking off
   local disk/memory (see the warnings above) before relying on this at real volume —
   the email safety net covers bookings for now, but isn't a full substitute for this.
6. Link to it from the relevant Com'mon People guide pages — see "Attaching this to
   the-common-people.com" below.

## Attaching this to the-common-people.com

This app is deliberately built and hosted as a **separate, standalone app** (currently
on Render, at whatever URL Render gives it — check your Render dashboard's service
page for the exact address), not bolted directly into the static
`the-common-people.com` site's own codebase. There are two ways to connect the two,
and they're not mutually exclusive:

**Option A — simplest: just link to it.** On `the-common-people.com` (e.g. from
`guide-interview-prep.html` or `resources.html`), add a button/link such as:

```html
<a href="https://YOUR-RENDER-URL.onrender.com" class="btn-primary">Get your personalised interview prep report — £25</a>
```

Since you manage that site's HTML directly through GitHub, this is a plain content
edit — add the link, commit, push, and Cloudflare/your host serves the updated page.
No DNS work needed. The address bar will show the Render URL once someone clicks
through, which is a bit less polished but works today with zero extra setup.

**Option B — cleaner: put it on its own subdomain of your real domain,** e.g.
`prep.thecommonpeople.co.uk`, so it never shows an `onrender.com` address at all:

1. In Render: your service → **Settings → Custom Domains** → add
   `prep.thecommonpeople.co.uk` (or whatever subdomain you'd like). Render will show
   you a target hostname to point at (something like `your-service.onrender.com`).
2. In Cloudflare: DNS → add a **CNAME** record — Name: `prep` (or your chosen
   subdomain), Target: the hostname Render gave you in step 1. Leave proxy status as
   Render's docs recommend for custom domains (usually **DNS only**, i.e. the grey
   cloud, not the orange "proxied" cloud, since Render needs to issue its own SSL
   certificate for the domain).
3. Wait for DNS to propagate (usually minutes, sometimes up to an hour) and for
   Render to show the custom domain as verified with a certificate issued.
4. Then use Option A's link, but pointing at `https://prep.thecommonpeople.co.uk`
   instead of the onrender.com address.

Either way, nothing about the app itself needs to change — this is purely about how
people get to it from the main site.
