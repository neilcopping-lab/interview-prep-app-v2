# The Com'mon People — Interview Prep Report (prototype)

A working prototype of the £45 automated interview prep report concept: paste a job
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
| Payment | ⚠️ Stubbed — `/api/checkout` returns a message, not a real session | Add `STRIPE_SECRET_KEY`, create a real Stripe Checkout session, gate `/api/report*` behind a confirmed payment |
| Docx export | ✅ Working, auto-downloads the moment the report finishes generating | — |
| Visual design | ✅ Matched to the-common-people.com (Anton/Oswald/Arvo fonts, navy/mustard/sky-blue/orange palette pulled from the live site) | — |
| Coaching call add-on (£29) | ✅ Real booking system — generates genuine availability, prevents double-booking (`lib/booking.js`) | Add payment gate (see Payment row) so slots are only bookable after the £29 is confirmed paid. Also move off local-disk storage before real launch — see the ⚠️ note below. |
| Privacy & data notice | ✅ Draft published at `/privacy.html`, linked from the app | Have this reviewed properly (by a solicitor if budget allows) before real users' data flows through it |

The remaining stubbed spot (payment) is marked `AI UPGRADE POINT` / clearly commented in
`server.js` so it's easy to find.

## ⚠️ Before taking real bookings or payments

- **Booking storage is not production-safe yet.** `lib/booking.js` stores bookings in a
  plain JSON file on local disk. On Render's free tier, local disk does **not** persist
  across restarts or redeploys — bookings could be silently lost. Move to Render's paid
  persistent disk, or better, a real database, before this goes live.
- **Neither payment is wired up.** Right now anyone can generate a report or book a
  coaching slot without paying. Both need a real Stripe Checkout flow before launch.
- **Uploads are validated but not scanned.** File size is capped at 10MB and type is
  restricted to PDF/Word/text/audio server-side, but there's no malware scanning. Low
  risk at this scale, worth revisiting if volume grows.
- **A report now costs a bit more in API usage than earlier versions.** Each report
  involves ~9 AI calls (5 of them Claude web-search calls, plus one OpenAI image
  generation for the cover art) instead of the original ~4. Still trivial against the £45
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

## Next steps to go live

1. ✅ ~~Add `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`~~ — done, report generation and
   transcription are live.
2. Add `STRIPE_SECRET_KEY`, create a real Checkout session in `/api/checkout`, and gate
   report generation (and coaching bookings) behind a confirmed payment (webhook + a
   short-lived access token is the standard pattern).
3. Review the privacy notice at `/privacy.html` (draft included) and get it properly
   checked before real users' data flows through the app — see the Legal, Data and
   Trust section of the concept document for the full list of what needs covering.
4. Move booking storage off local disk (see the warning above) before real bookings.
5. Link to it from the relevant Com'mon People guide pages.
