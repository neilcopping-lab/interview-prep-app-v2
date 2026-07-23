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
| Coaching call add-on (£45) | ✅ Real booking system — generates genuine availability, prevents double-booking (`lib/booking.js`) | Add payment gate (see Payment row) so slots are only bookable after the £45 is confirmed paid. Also move off local-disk storage before real launch — see the ⚠️ note below. |
| Privacy & data notice | ✅ Draft published at `/privacy.html`, linked from the app | Have this reviewed properly (by a solicitor if budget allows) before real users' data flows through it |

The remaining stubbed spot (payment) is marked `AI UPGRADE POINT` / clearly commented in
`server.js` so it's easy to find.

## ⚠️ Before taking real bookings or payments

- **Booking storage is not production-safe yet.** `lib/booking.js` stores bookings in a
  plain JSON file on local disk. On Render's free tier, local disk does **not** persist
  across restarts or redeploys — bookings could be silently lost. Move to Render's paid
  persistent disk, or better, a real database, before this goes live.
- **The £25 report payment is live; the £45 coaching add-on booking still isn't
  gated.** Anyone can currently book a coaching slot without paying the £45 — the
  same Stripe pattern used for the report (see below) needs applying to
  `/api/booking/book` before that's real.
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
2. In the Stripe dashboard, make sure you're in **Test mode** first (toggle top-right)
   — this lets you run through a whole payment with a fake card before ever touching
   real money.
3. Go to **Developers → API keys** and copy the **Secret key** (starts `sk_test_...`
   in test mode, `sk_live_...` once you switch to live mode).
4. In Render: your service → **Environment** tab → add a new variable named
   `STRIPE_SECRET_KEY` with that value → save (Render redeploys automatically).
5. Test it: run through the app, and on the "Pay & generate my report" step you should
   land on a real Stripe checkout page. Use Stripe's test card `4242 4242 4242 4242`,
   any future expiry date, any 3-digit CVC, any postcode — it'll complete as a
   successful test payment and bring you straight back to your generated report.
6. When you're ready to take real payments, switch Stripe to **Live mode**, copy the
   live secret key (`sk_live_...`) from the same API keys page, and replace the value
   in Render's Environment tab with it. That's the only change needed to go from test
   to real payments.

## Next steps to go live

1. ✅ ~~Add `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`~~ — done, report generation and
   transcription are live.
2. ✅ ~~Add `STRIPE_SECRET_KEY`, wire up a real Checkout session, gate report
   generation~~ — done for the £25 report (see the setup steps above). Still to do:
   apply the same gate to the £45 coaching add-on booking (see the ⚠️ note above).
3. Review the privacy notice at `/privacy.html` (draft included) and get it properly
   checked before real users' data flows through the app — see the Legal, Data and
   Trust section of the concept document for the full list of what needs covering.
4. Move booking storage, consent records, and the Stripe used-session tracking off
   local disk/memory (see the warnings above) before relying on this at real volume.
5. Link to it from the relevant Com'mon People guide pages — see "Attaching this to
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
