// ---------------- HELPERS ----------------
function $(id) { return document.getElementById(id); }

// Safe listener attachment — logs a console warning instead of throwing
// if the element isn't found. A partial deploy where index.html and
// app.js fall out of sync used to crash the whole script on the first
// missing element, silently killing every listener after it (including
// the Continue button) — this stops that from happening again.
function on(id, event, handler) {
  const el = $(id);
  if (el) el.addEventListener(event, handler);
  else console.warn(`[app] element #${id} not found — listener for "${event}" not attached.`);
}

const state = {
  candidateName: "",
  companyName: "",
  connectDetail: "",
  values: [],
  jobDescription: "",
  cvText: "",
  answers: [],
  generatedReport: null,
};

function showPanel(n) {
  [1, 2, 3].forEach((i) => {
    const panel = $(`panel${i}`);
    if (panel) panel.classList.toggle("hidden", i !== n);
  });
}
showPanel(1);

// ---------------- PAYMENT (Stripe Checkout) ----------------
// Stripe's hosted checkout is a full page redirect away from this app and
// back — there's no way to keep the candidate's in-memory `state` (their
// CV, job description, recorded answers) alive across that round trip
// without persisting it somewhere first. localStorage is the simple,
// correct tool for that here (this is a real production page, not a
// throwaway preview) — it survives the redirect to Stripe's domain and
// back, and is cleared right after a successful restore so a stale copy
// can't leak into a later, unrelated session on the same browser.
const PENDING_STATE_KEY = "interviewPrep.pendingState";

function savePendingState() {
  try {
    localStorage.setItem(PENDING_STATE_KEY, JSON.stringify(state));
  } catch (err) {
    console.error("[payment] could not save state before redirecting to checkout:", err);
  }
}

function restorePendingState() {
  try {
    const raw = localStorage.getItem(PENDING_STATE_KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw);
    Object.assign(state, saved);
    localStorage.removeItem(PENDING_STATE_KEY);
    return true;
  } catch (err) {
    console.error("[payment] could not restore saved state after checkout:", err);
    return false;
  }
}

// Runs once on page load. Three cases: fresh visit (neither param set —
// does nothing, normal step-1 start); back from a successful Stripe
// payment (?paid=1&session_id=...); or back from a cancelled/abandoned
// checkout (?canceled=1). Either way, the query string is cleaned off the
// URL immediately after so refreshing the page doesn't re-trigger this.
async function handleCheckoutReturn() {
  const params = new URLSearchParams(window.location.search);
  const paid = params.get("paid");
  const canceled = params.get("canceled");
  const sessionId = params.get("session_id");
  if (!paid && !canceled) return;

  window.history.replaceState({}, "", window.location.pathname);

  if (canceled) {
    if (!restorePendingState()) return; // nothing to restore, was probably a stray param
    renderQuestions();
    showPanel(2);
    if ($("questionStatus")) $("questionStatus").textContent = "Checkout was cancelled — you haven't been charged. Ready to try again whenever you are.";
    return;
  }

  if (paid && sessionId) {
    if (!restorePendingState()) return;
    renderQuestions();
    showPanel(3);
    if ($("genStatus")) $("genStatus").textContent = "Payment confirmed — generating your report…";
    try {
      const res = await fetch(`/api/checkout/verify?session_id=${encodeURIComponent(sessionId)}`);
      const check = await res.json();
      if (!check.paid) {
        if ($("genStatus")) $("genStatus").textContent = check.error || "Could not confirm payment — please go back and try again.";
        showPanel(2);
        return;
      }
      await generateAndShowReport(sessionId);
    } catch (err) {
      console.error(err);
      if ($("genStatus")) $("genStatus").textContent = "Could not confirm payment — please go back and try again.";
      showPanel(2);
    }
  }
}

// ---------------- STEP 1 ----------------
async function extractFileText(file) {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/api/extract-text", { method: "POST", body: fd });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Could not read that file.");
  return data.text;
}

on("jdFile", "change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await extractFileText(file);
    if ($("jobDescription")) $("jobDescription").value = text;
  } catch (err) {
    alert(err.message || "Could not read that file — please paste the job description instead.");
  }
});

on("cvFile", "change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await extractFileText(file);
    if ($("cvText")) $("cvText").value = text;
  } catch (err) {
    alert(err.message || "Could not read that file — please paste your CV instead.");
  }
});

on("toStep2", "click", async () => {
  state.candidateName = $("candidateName")?.value.trim() || "";
  state.candidateEmail = $("candidateEmail")?.value.trim() || "";
  state.companyName = $("companyName")?.value.trim() || "";
  state.connectDetail = $("connectDetail")?.value.trim() || "";
  state.values = ($("values")?.value || "").split(",").map((v) => v.trim()).filter(Boolean);
  state.jobDescription = $("jobDescription")?.value.trim() || "";
  state.cvText = $("cvText")?.value.trim() || "";
  const agreedToPrivacy = !!$("agreePrivacy")?.checked;
  const marketingOptIn = !!$("marketingOptIn")?.checked;

  if (!state.jobDescription || !state.cvText) {
    if ($("questionStatus")) $("questionStatus").textContent = "Please add both a job description and your CV before continuing.";
    return;
  }
  // A valid email and an explicit tick against the Privacy & Data Notice
  // are both required before we generate anything — this is deliberately
  // checked here, not just left to the server, so the candidate sees a
  // clear reason immediately rather than a generic error.
  const emailLooksValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(state.candidateEmail);
  if (!emailLooksValid) {
    if ($("consentStatus")) $("consentStatus").textContent = "Please add a valid email address to continue.";
    return;
  }
  if (!agreedToPrivacy) {
    if ($("consentStatus")) $("consentStatus").textContent = "Please tick the box agreeing to the Privacy & Data Notice to continue.";
    return;
  }
  if ($("consentStatus")) $("consentStatus").textContent = "";

  // Record the consent server-side before moving on. This is a genuine
  // "best effort" — if logging it fails for some reason (network blip,
  // disk issue), that's an internal record-keeping problem, not something
  // that should block a candidate who's already agreed from getting the
  // report they're here for.
  try {
    await fetch("/api/consent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: state.candidateName,
        email: state.candidateEmail,
        companyName: state.companyName,
        agreedToPrivacy,
        marketingOptIn,
      }),
    });
  } catch (err) {
    console.error("[consent] could not record consent (continuing anyway):", err);
  }

  if ($("questionStatus")) $("questionStatus").textContent = "Picking the right questions for this role…";
  try {
    const res = await fetch("/api/questions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobDescription: state.jobDescription, count: 5 }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not select questions");
    state.answers = (data.questions || []).map((q) => ({ question: q.question, transcript: "", basedOn: q.basedOn || "" }));
    renderQuestions();
    if ($("questionStatus")) $("questionStatus").textContent = "";
    showPanel(2);
  } catch (err) {
    console.error(err);
    if ($("questionStatus")) $("questionStatus").textContent = "Something went wrong picking questions — please try again.";
  }
});

// ---------------- STEP 2 ----------------
function renderQuestions() {
  const container = $("questionList");
  if (!container) return;
  container.innerHTML = "";
  state.answers.forEach((a, idx) => {
    const card = document.createElement("div");
    card.className = "qa-card";
    const basedOnHtml = a.basedOn
      ? `<div class="qa-based-on">Based on: <span>"${a.basedOn}"</span> in the job description</div>`
      : "";
    card.innerHTML = `
      <h4>${idx + 1}. ${a.question}</h4>
      ${basedOnHtml}
      <div class="qa-controls">
        <button class="record-btn" data-idx="${idx}">● Record answer</button>
        <span class="qa-status" id="qa-status-${idx}">Not recorded — you can also just type below</span>
      </div>
      <textarea rows="3" id="qa-text-${idx}" placeholder="Type or paste your answer here"></textarea>
    `;
    container.appendChild(card);
  });

  container.querySelectorAll(".record-btn").forEach((btn) => {
    btn.addEventListener("click", () => toggleRecording(btn));
  });
}

let mediaRecorder, audioChunks = [], activeKey = null;

// Works for two kinds of record buttons: STAR-answer buttons (data-idx —
// text goes into the qa-text-N textarea) and plain field buttons
// (data-target="someInputId" — text goes straight into that input, used
// for the "personal detail" and "top values" fields on step 1). Both share
// the same recording/transcription plumbing, just a different place to put
// the resulting text and status message.
function recordingTargets(btn) {
  if (btn.dataset.idx !== undefined) {
    const idx = btn.dataset.idx;
    return { key: `idx:${idx}`, textEl: $(`qa-text-${idx}`), statusEl: $(`qa-status-${idx}`), idleLabel: "● Record answer" };
  }
  const target = btn.dataset.target;
  return { key: `field:${target}`, textEl: $(target), statusEl: $(`${target}-status`), idleLabel: "● Record" };
}

async function toggleRecording(btn) {
  const { key, textEl, statusEl, idleLabel } = recordingTargets(btn);
  if (mediaRecorder && mediaRecorder.state === "recording" && activeKey === key) {
    mediaRecorder.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    activeKey = key;
    audioChunks = [];

    // Safari (and some other browsers) don't support 'audio/webm' at all —
    // if you force it as the MediaRecorder mimeType, recording silently
    // fails or falls back to whatever the browser actually supports (often
    // 'audio/mp4'), while the code used to hardcode the blob's type and
    // filename as "audio/webm" regardless. OpenAI then received a file
    // labelled webm that wasn't actually webm-encoded, rejected it, and
    // transcription failed every time on Safari — this was the real bug
    // behind "Transcription hit a problem just now" persisting even after
    // the OpenAI billing/account issue was fixed. Ask the browser what it
    // actually supports and use that, both for recording and for the
    // filename/type sent to the server, instead of assuming webm.
    const preferredTypes = ["audio/webm", "audio/mp4", "audio/ogg", "audio/mpeg"];
    const supportedType = preferredTypes.find(
      (t) => window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)
    );
    mediaRecorder = supportedType ? new MediaRecorder(stream, { mimeType: supportedType }) : new MediaRecorder(stream);

    mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
    mediaRecorder.onstop = async () => {
      btn.classList.remove("recording");
      btn.textContent = idleLabel;
      stream.getTracks().forEach((t) => t.stop());
      // Use whatever format the recorder actually produced (mediaRecorder.mimeType
      // reflects what really got encoded), not a hardcoded guess.
      const actualType = mediaRecorder.mimeType || "audio/webm";
      const ext = actualType.includes("mp4") ? "m4a" : actualType.includes("ogg") ? "ogg" : actualType.includes("mpeg") ? "mp3" : "webm";
      const blob = new Blob(audioChunks, { type: actualType });
      if (statusEl) statusEl.textContent = "Transcribing…";
      const fd = new FormData();
      fd.append("audio", blob, `answer.${ext}`);
      const res = await fetch("/api/transcribe", { method: "POST", body: fd });
      const data = await res.json();
      if (data.text && textEl) {
        textEl.value = data.text;
        if (statusEl) statusEl.textContent = "Transcribed ✓";
      } else if (statusEl) {
        statusEl.textContent = data.message || "Transcription unavailable — please type your answer.";
      }
    };
    mediaRecorder.start();
    btn.classList.add("recording");
    btn.textContent = "■ Stop";
    if (statusEl) statusEl.textContent = "Recording…";
  } catch (err) {
    alert("Couldn't access the microphone. You can type your answer instead.");
  }
}

// Step-1 record buttons (personal detail, top values) exist in the static
// HTML from page load, unlike the STAR-answer buttons which are rendered
// dynamically per question — so they're wired up once here rather than in
// renderQuestions().
document.querySelectorAll(".record-btn-inline").forEach((btn) => {
  btn.addEventListener("click", () => toggleRecording(btn));
});

on("back1", "click", () => showPanel(1));

// Report generation now serialises its Claude calls one at a time (see
// lib/aiClients.js — a deliberate trade-off for reliability against a low
// per-minute rate limit), so a report can realistically take anywhere
// from ~30s to over 2 minutes depending on how much retrying is needed.
// There's no real server-pushed progress, so this cycles through a
// believable sequence of what the AI is actually doing at that point, one
// step at a time, so the wait doesn't look frozen. Purely cosmetic timing
// — it doesn't track real completion — but it's an honest description of
// the actual work happening (the backend does genuinely read the CV, read
// the JD, then research the company, reviews, etc., in roughly this order).
const GENERATION_STEPS = [
  "Reading your CV…",
  "Reading the job description…",
  "Researching the company…",
  "Checking Glassdoor and employee reviews…",
  "Scanning social media presence…",
  "Checking recent news and press coverage…",
  "Weighing up market and sector trends…",
  "Thinking through the challenges of the role…",
  "Comparing your CV against the job spec…",
  "Drafting your opening pitch…",
  "Tidying up your STAR answers…",
  "Designing your cover artwork…",
  "Putting the report together…",
];

// A literal countdown that hits "0:00" and then just sits there while the
// request is still running looks more broken than no countdown at all —
// and because real generation time varies a lot (rate limits, retries),
// a fixed countdown WILL often run out before the report is actually
// ready. So this decelerates as it approaches the estimate (classic
// "fake progress bar" curve — fast at first, crawling near the end)
// rather than ticking evenly to zero, and once it's essentially out of
// runway it switches to an honest "taking longer than usual" message
// instead of showing 0:00 or negative time.
// Claude calls now run with some concurrency (2 at a time, see
// lib/aiClients.js) rather than dead-serial, so this is well under the
// old 100s estimate, but not as low as full concurrency would allow —
// left some headroom for the occasional retry.
const ESTIMATED_GENERATION_SECONDS = 70;

function formatRemaining(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `about ${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `about ${m}m ${rem}s`;
}

function startGenerationProgress() {
  const statusEl = $("genStatus");
  const barEl = $("genProgressBar");
  const fillEl = $("genProgressFill");
  const countdownEl = $("genCountdown");
  if (!statusEl) return () => {};

  let stepIdx = 0;
  statusEl.classList.add("gen-progress");
  statusEl.textContent = GENERATION_STEPS[0];
  if (barEl) barEl.classList.remove("hidden");

  const startedAt = Date.now();
  const stepTimer = setInterval(() => {
    stepIdx = (stepIdx + 1) % GENERATION_STEPS.length;
    statusEl.textContent = GENERATION_STEPS[stepIdx];
  }, 2200);

  const tickTimer = setInterval(() => {
    const elapsed = (Date.now() - startedAt) / 1000;
    // Eases toward, but never quite reaches, 96% — decelerating curve so
    // it feels like real progress rather than a linear bar that stalls.
    const fraction = 1 - Math.exp(-elapsed / (ESTIMATED_GENERATION_SECONDS * 0.6));
    const percent = Math.min(96, fraction * 96);
    if (fillEl) fillEl.style.width = `${percent}%`;

    const remaining = ESTIMATED_GENERATION_SECONDS - elapsed;
    if (!countdownEl) return;
    if (remaining > 8) {
      countdownEl.textContent = `${formatRemaining(remaining)} remaining`;
    } else {
      countdownEl.textContent = "Almost there — this can take a little longer than usual…";
    }
  }, 1000);

  return () => {
    clearInterval(stepTimer);
    clearInterval(tickTimer);
    statusEl.classList.remove("gen-progress");
    if (fillEl) fillEl.style.width = "100%";
    if (barEl) setTimeout(() => barEl.classList.add("hidden"), 400);
    if (countdownEl) countdownEl.textContent = "";
  };
}

// Does the actual report generation + render — shared by both the normal
// "no payment configured yet" path and the "just came back from a
// successful Stripe payment" path, so there's exactly one place this logic
// lives. stripeSessionId is undefined when Stripe isn't configured (the
// server-side gate skips the check entirely in that case — see server.js).
async function generateAndShowReport(stripeSessionId) {
  if ($("reportPreview")) $("reportPreview").innerHTML = "";
  const stopProgress = startGenerationProgress();

  try {
    const res = await fetch("/api/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...state, stripeSessionId }),
    });
    const report = await res.json();
    if (!res.ok) throw new Error(report.error || "Could not generate report");
    state.generatedReport = report; // reused by downloadReportAsDocx so we don't pay for every AI call (and the cover image) twice
    renderReport(report);
    stopProgress();
    // aiPowered reflects whether a Claude call actually returned real
    // content, not just whether a key is set — so this message stays
    // accurate even when a key is present but invalid/expired/rate-limited.
    let aiTag = " (prototype mode — add ANTHROPIC_API_KEY for full AI generation)";
    if (report.aiPowered) aiTag = " (AI-powered)";
    else if (report.aiKeyPresent) aiTag = " (prototype mode — an API key is set but calls aren't succeeding; check the key and Render logs)";
    if ($("genStatus")) $("genStatus").textContent = `Generated for ${report.candidateName || "you"} — ${report.companyName || "this role"}${aiTag}`;
    // Downloadable the moment it's ready — paid for it, get it immediately,
    // don't make them hunt for a button. The button stays too, for a re-download.
    downloadReportAsDocx();
    renderAddonCard();
  } catch (err) {
    console.error(err);
    stopProgress();
    if ($("genStatus")) $("genStatus").textContent = err.message && err.message.includes("Payment")
      ? err.message
      : "Something went wrong generating the report — please go back and try again.";
  }
}

on("toStep3", "click", async () => {
  state.answers.forEach((a, idx) => {
    a.transcript = ($(`qa-text-${idx}`)?.value || "").trim();
  });

  if ($("toStep3")) { $("toStep3").disabled = true; $("toStep3").textContent = "Please wait…"; }
  try {
    const res = await fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidateEmail: state.candidateEmail, companyName: state.companyName }),
    });
    const data = await res.json();
    if (data.url) {
      // Off to Stripe's hosted checkout page — save everything collected
      // so far, since this is a full navigation away from the app and this
      // script's in-memory `state` won't survive it. handleCheckoutReturn()
      // picks it back up when Stripe sends the candidate back.
      savePendingState();
      window.location.href = data.url;
      return;
    }
    // Stripe isn't configured yet (no STRIPE_SECRET_KEY set) — fall back
    // to generating the report directly, same as before payment existed,
    // rather than blocking the whole app on a payment setup that isn't
    // done yet.
    console.warn("[payment] Stripe not configured, generating report without payment:", data.message);
    showPanel(3);
    await generateAndShowReport();
  } catch (err) {
    console.error("[payment] could not start checkout, generating report without payment:", err);
    showPanel(3);
    await generateAndShowReport();
  } finally {
    if ($("toStep3")) { $("toStep3").disabled = false; $("toStep3").textContent = "Pay & generate my report"; }
  }
});

handleCheckoutReturn();

on("back2", "click", () => showPanel(2));

// ---------------- STEP 3 ----------------
function block(title, html) {
  return `<div class="report-block"><h3>${title}</h3>${html}</div>`;
}
function upgradeFlagIfNeeded(text) {
  if (text && text.includes("[AI UPGRADE POINT")) {
    return `<div class="upgrade-flag">⚠ ${text}</div>`;
  }
  return `<p>${text}</p>`;
}
// Renders the "Sources:" line under a researched section — only appears
// when Claude's web search actually returned citations for that section.
function sourcesHtml(sources) {
  if (!sources || !sources.length) return "";
  const links = sources.map((s) => `<a href="${s.url}" target="_blank" rel="noopener">${s.title}</a>`).join(" &nbsp;•&nbsp; ");
  return `<div class="report-sources"><b>Sources:</b> ${links}</div>`;
}
// Renders a { headline, bullets, sources } research section as a real
// bullet list — this is what replaced the old wall-of-prose paragraphs.
// Falls back to the upgrade-flag treatment if the AI call fell back
// (bullets will be empty in that case).
function researchBlock(title, section) {
  const headline = section.headline ? `<p>${section.headline}</p>` : "";
  const bullets = section.bullets && section.bullets.length
    ? `<ul>${section.bullets.map((b) => `<li>${b}</li>`).join("")}</ul>`
    : upgradeFlagIfNeeded(section.headline || "");
  return block(title, headline + bullets + sourcesHtml(section.sources));
}
// Small inline SVG bar showing how much of the JD the CV covers — a
// supporting visual next to the actual Cake + Cherry bullet analysis,
// not a replacement for it.
function skillsMatchSvg(skillsMatch) {
  if (!skillsMatch || skillsMatch.percent === null) return "";
  const pct = skillsMatch.percent;
  const w = 400, h = 26;
  const filledW = Math.round((w * pct) / 100);
  return `
    <div class="skills-match">
      <div class="skills-match-label"><b>Skills Match: ${pct}%</b> — ${skillsMatch.matched} of ${skillsMatch.total} job requirements matched to your CV</div>
      <svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" role="img" aria-label="Skills match ${pct} percent">
        <rect x="0" y="0" width="${w}" height="${h}" rx="4" fill="rgba(236,230,216,0.12)"></rect>
        <rect x="0" y="0" width="${filledW}" height="${h}" rx="4" fill="var(--mustard)"></rect>
      </svg>
    </div>
  `;
}
// Bespoke cover banner — the AI-generated abstract artwork (if it rendered
// successfully) with the candidate/company name overlaid as real HTML
// text, not AI-rendered text. Omitted cleanly if no image came back (no
// OPENAI_API_KEY, or the call failed) — never blocks the rest of the report.
function coverBannerHtml(r) {
  const img = (r.cover && r.cover.base64) ? `<img src="data:image/png;base64,${r.cover.base64}" alt="Cover artwork" />` : "";
  return `
    <div class="cover-banner">
      ${img}
      <div class="cover-banner-text">
        <div class="cover-banner-title">Interview Preparation Report</div>
        <div class="cover-banner-brand">Produced by The Com'mon People AI</div>
        <div class="cover-banner-name">${r.candidateName || "Your"}</div>
        <div class="cover-banner-sub">Interview Prep — ${r.companyName || "Your Role"}</div>
      </div>
    </div>
  `;
}

// One consolidated "Sources & References" block at the end of the report —
// every real citation gathered across all the research sections, grouped
// by which section it backs, in addition to the inline "Sources:" line
// already shown under each individual section.
function allSourcesHtml(allSources) {
  if (!allSources || !allSources.length) return "";
  const bySection = {};
  allSources.forEach((s) => {
    if (!bySection[s.section]) bySection[s.section] = [];
    bySection[s.section].push(s);
  });
  const groups = Object.entries(bySection).map(([section, list]) => `
    <h4>${section}</h4>
    <ul>${list.map((s) => `<li><a href="${s.url}" target="_blank" rel="noopener">${s.title}</a></li>`).join("")}</ul>
  `).join("");
  return block("11. Sources &amp; References", `
    <p>Every source the AI actually drew on while researching this report, for your own reference or spot-checking.</p>
    <div class="report-sources-all">${groups}</div>
  `);
}

function renderReport(r) {
  let html = coverBannerHtml(r);

  html += researchBlock("1. Company Overview", r.research);
  html += researchBlock("2. Recent News &amp; Press Activity", r.recentNews);
  html += researchBlock("3. Employee Sentiment (Reviews)", r.employeeSentiment);
  html += researchBlock("4. Social Media Presence", r.socialMedia);
  html += researchBlock("5. Market &amp; Sector Intelligence", r.marketIntelligence);
  html += researchBlock("6. Challenges You May Be Facing in This Role", r.roleChallenges);

  html += block("7. Opening Pitch — The Pitch Sandwich", `
    <h4>Bread 1 — Connect</h4>${upgradeFlagIfNeeded(r.pitch.bread1)}
    <h4>Filling — Fit</h4>${upgradeFlagIfNeeded(r.pitch.filling)}
    <h4>Bread 2 — Values</h4>${upgradeFlagIfNeeded(r.pitch.bread2)}
  `);

  const matched = r.gapAnalysis.matchedStrengths.length
    ? `<p><b>Matched strengths:</b></p><ul>${r.gapAnalysis.matchedStrengths.map((m) => `<li>${m}</li>`).join("")}</ul>`
    : `<p><b>Matched strengths:</b> none detected — check the CV genuinely covers this role.</p>`;
  const gaps = r.gapAnalysis.developmentAreas.map((d) =>
    `<div class="star-line"><b>Area:</b> ${d.area}</div><div class="upgrade-flag">⚠ ${d.cherry}</div>`
  ).join("");
  html += block("8. Gap Analysis — the Cake + Cherry Method", skillsMatchSvg(r.skillsMatch) + matched + gaps);

  const guide = r.starGuide;
  const guideHtml = guide ? `
    <p>${guide.intro}</p>
    <div class="star-grid">
      ${guide.steps.map((s) => `<div class="star-item"><b>${s.letter}</b> ${s.label} — ${s.explanation}</div>`).join("")}
    </div>
    <ul>${guide.tips.map((t) => `<li>${t}</li>`).join("")}</ul>
    ${r.questionsFootnote ? `<div class="info-note">${r.questionsFootnote}</div>` : ""}
    <hr style="border:none;border-top:1px solid rgba(236,230,216,0.15);margin:16px 0;">
  ` : "";

  const stars = r.starAnswers.map((a) => `
    <h4>${a.question}</h4>
    ${a.basedOn ? `<div class="qa-based-on">Based on: <span>"${a.basedOn}"</span> in the job description</div>` : ""}
    <div class="star-line"><b>Situation:</b> ${a.situation}</div>
    <div class="star-line"><b>Task:</b> ${a.task || "—"}</div>
    <div class="star-line"><b>Action:</b> ${a.action || "—"}</div>
    <div class="star-line"><b>Result:</b> ${a.result || "—"}</div>
    ${a.note ? `<div class="upgrade-flag">⚠ ${a.note}</div>` : ""}
  `).join("<hr style='border:none;border-top:1px solid rgba(236,230,216,0.15);margin:14px 0;'>");
  html += block("9. How to Answer, and Your STAR Answers", guideHtml + stars);

  const qs = Object.entries(r.questionsToAsk).map(([type, list]) => `
    <h4>${type}</h4><ul>${list.map((q) => `<li>${q}</li>`).join("")}</ul>
  `).join("");
  html += block("10. Your Questions", qs);

  html += allSourcesHtml(r.allSources);

  $("reportPreview").innerHTML = html;
}

async function downloadReportAsDocx() {
  try {
    // Reuse the report we already generated for the on-screen preview
    // (state.generatedReport) instead of regenerating every AI call —
    // and the cover image — a second time just to build the .docx.
    const body = state.generatedReport ? { report: state.generatedReport } : state;
    const res = await fetch("/api/report/docx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) { alert("Could not build the document."); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "Interview_Prep_Report.docx";
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error(err);
    alert("Could not build the document — use the Download button to try again.");
  }
}

on("downloadDocx", "click", downloadReportAsDocx);

// ---------------- COACHING ADD-ON ----------------
function renderAddonCard() {
  const el = $("addonCard");
  if (!el) return;
  el.classList.remove("hidden");
}

let chosenSlot = null;

function renderSlots(slots) {
  const el = $("slotList");
  if (!el) return;
  if (!slots.length) {
    el.innerHTML = "<p>No slots available right now — please check back soon.</p>";
    return;
  }
  const byDay = {};
  slots.forEach((slot) => {
    const day = slot.split("T")[0];
    if (!byDay[day]) byDay[day] = [];
    byDay[day].push(slot);
  });
  el.innerHTML = Object.entries(byDay).map(([day, daySlots]) => `
    <div class="slot-day">
      <h4>${new Date(day + "T00:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}</h4>
      <div class="slot-buttons">
        ${daySlots.map((s) => `<button type="button" class="slot-btn" data-slot="${s}">${s.split("T")[1]}</button>`).join("")}
      </div>
    </div>
  `).join("");

  el.querySelectorAll(".slot-btn").forEach((btn) => {
    btn.addEventListener("click", () => selectSlot(btn));
  });
}

function selectSlot(btn) {
  document.querySelectorAll(".slot-btn.selected").forEach((b) => b.classList.remove("selected"));
  btn.classList.add("selected");
  chosenSlot = btn.dataset.slot;
  if ($("bookingForm")) $("bookingForm").classList.remove("hidden");
}

on("showBooking", "click", async () => {
  const panel = $("bookingPanel");
  const slotList = $("slotList");
  if (!panel || !slotList) return;
  panel.classList.remove("hidden");
  slotList.innerHTML = "Loading available times…";
  try {
    const res = await fetch("/api/booking/slots");
    const data = await res.json();
    renderSlots(data.slots || []);
  } catch (err) {
    slotList.innerHTML = "Could not load available times — please try again shortly.";
  }
});

on("confirmBooking", "click", async () => {
  const statusEl = $("bookingStatus");
  if (!chosenSlot) {
    if (statusEl) statusEl.textContent = "Please pick a time first.";
    return;
  }
  const name = $("bookingName")?.value.trim();
  const email = $("bookingEmail")?.value.trim();
  if (!name || !email) {
    if (statusEl) statusEl.textContent = "Please add your name and email.";
    return;
  }
  if (statusEl) statusEl.textContent = "Booking…";
  try {
    const res = await fetch("/api/booking/book", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot: chosenSlot, name, email, companyName: state.companyName }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "Could not book that slot");
    if (statusEl) statusEl.textContent = `Booked ✓ — ${chosenSlot.replace("T", " ")}. A confirmation will follow by email.`;
  } catch (err) {
    if (statusEl) statusEl.textContent = err.message || "Could not book that slot — please try another time.";
  }
});
