/**
 * Report generation logic for the Com'mon People Interview Prep Report.
 *
 * LIVE MODE (when ANTHROPIC_API_KEY is set): company research, gap analysis,
 * the pitch's "Fit" summary and STAR answer drafting all run through Claude.
 * Company research uses the web search tool so it's grounded in current,
 * real information rather than the model's training data.
 *
 * FALLBACK MODE (no key, or a call fails for any reason — rate limit,
 * network blip, etc.): every function below drops back to the original
 * rule-based prototype logic instead of throwing. A paying customer should
 * never see a broken report because of a transient API error; they should,
 * at worst, see a slightly less polished one. Each fallback result is
 * tagged internally so it's obvious in testing which path ran.
 */

const { hasAnthropic, claudeText, claudeJSON, generateCoverImage } = require("./aiClients");

const STOPWORDS = new Set([
  "the","a","an","and","or","but","of","to","in","on","for","with","as","is","are",
  "be","by","at","this","that","from","will","you","your","we","our","us","it","its",
  "or","not","have","has","had","who","what","when","where","why","how","their","they",
  "them","i","re","also","any","all","across","into","using","use","strong","good",
  "role","job","team","work","working","experience","skills","ability","able",
  // Generic JD/job-ad boilerplate that scores high by frequency but names no
  // real skill or requirement — without these, gap analysis was surfacing
  // junk "gaps" like "essential", "ensuring" and "hiring" instead of actual
  // competencies.
  "essential","desirable","ensuring","ensure","hiring","hire","responsible",
  "responsibilities","requirement","requirements","required","including",
  "include","includes","ideal","candidate","candidates","apply","applicant",
  "applicants","join","joining","position","positions","organisation",
  "organization","company","employer","employment","successful","person",
  "someone","looking","seek","seeking","must","should","would","can","need",
  "needs","needed","within","other","some","more","most","such","per","new",
]);

function topKeywords(text, n = 20) {
  const counts = {};
  (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w))
    .forEach((w) => { counts[w] = (counts[w] || 0) + 1; });
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([w]) => w);
}

// ---------------------------------------------------------------------
// Personalised cover art. Uses OpenAI's image API (not Claude — Anthropic
// doesn't do image generation) to create an abstract, on-brand piece
// themed around the candidate and the role, not a literal attempt at
// depicting the real company (that would risk looking inaccurate, or
// bumping into their real logo/trademark). The candidate's name and the
// company name are rendered as real, crisp text on top afterwards (in
// docxExport.js and public/app.js) rather than asking the image model to
// render text itself, since AI-generated text in images is often garbled
// — not something a paying customer should see on their cover.
// Returns { base64 } or null (missing key, content policy block, error —
// the report should never break because the cover image didn't render).
// ---------------------------------------------------------------------

async function coverArt({ companyName, jobDescription }) {
  const theme = topKeywords(jobDescription, 8).slice(0, 4).join(", ");
  const prompt =
    `An elegant, abstract editorial cover illustration for a premium personalised career document. ` +
    `Modern minimalist geometric composition — sweeping shapes, subtle gradients and confident forward-` +
    `leaning motion, evoking ambition, growth and quiet confidence. Colour palette: deep navy (#161F29), ` +
    `warm mustard gold (#E0B03C), sky blue (#5AA9C2), with a touch of burnt orange (#D2691E). Loosely ` +
    `thematic to a career in: ${theme || "professional services"}. Absolutely no text, letters, numbers, ` +
    `logos, real company branding, recognisable buildings, or human faces — pure abstract/conceptual art, ` +
    `high-end magazine-cover quality.`;

  const buffer = await generateCoverImage(prompt);
  if (!buffer) return null;
  return { base64: buffer.toString("base64") };
}

// ---------------------------------------------------------------------
// Gap analysis
// ---------------------------------------------------------------------

function gapAnalysisHeuristic(jobDescription, cvText, companyName) {
  // Words drawn from the company's own name (e.g. "Royal", "Albert", "Hall")
  // are near-guaranteed to be frequent in a JD that repeats the company name
  // but say nothing about an actual skill gap — strip them out before scoring.
  const companyWords = new Set(
    (companyName || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
  );
  const jdWords = topKeywords(jobDescription, 25).filter((w) => !companyWords.has(w));
  const cvWords = new Set(topKeywords(cvText, 60));
  const matched = jdWords.filter((w) => cvWords.has(w));
  const gaps = jdWords.filter((w) => !cvWords.has(w)).slice(0, 6);
  return {
    matchedStrengths: matched,
    developmentAreas: gaps.map((area) => ({
      area,
      cherry: "[AI UPGRADE POINT: a proactive, credible solution for this gap would be drafted here]",
    })),
  };
}

async function gapAnalysis(jobDescription, cvText, companyName) {
  if (!hasAnthropic()) return gapAnalysisHeuristic(jobDescription, cvText, companyName);

  const result = await claudeJSON(
    `You're helping a candidate prepare for a job interview using the "Cake + Cherry" method: ` +
    `identify genuine gaps between their CV and the job description, then suggest a proactive, ` +
    `credible way to address each one (a course, a way to reframe adjacent experience, etc.) — ` +
    `never invent experience they don't have. Gaps must be real skills, tools or experience named or ` +
    `clearly implied by the job description — never the company's own name or generic filler words ` +
    `like "essential" or "hiring".\n\n` +
    `JOB DESCRIPTION:\n${jobDescription}\n\nCV:\n${cvText}\n\n` +
    `Return JSON in exactly this shape:\n` +
    `{"matchedStrengths": ["short phrase", ...up to 8], ` +
    `"developmentAreas": [{"area": "short phrase naming the gap", "cherry": "one or two sentence proactive solution, in second person (\\"you\\")"}] up to 5}`,
    { maxTokens: 1600 }
  );

  if (!result || !Array.isArray(result.matchedStrengths) || !Array.isArray(result.developmentAreas)) {
    return gapAnalysisHeuristic(jobDescription, cvText, companyName);
  }
  return result;
}

// ---------------------------------------------------------------------
// Research sections (company overview, employee sentiment, social media,
// market intelligence, recent news, role challenges). Each ultimately
// returns the same shape: { headline, bullets, sources } — a one-line
// framing sentence, a set of specific bullet points, and the real URLs
// Claude cited. This is what gets rendered as bullets (not dense
// paragraphs) in both the web preview and the .docx export.
//
// IMPORTANT: these used to be 6 separate Claude calls. Live testing on
// Neil's actual Anthropic account (see lib/aiClients.js) showed that even
// serialized one-at-a-time with retries, most of those 6 calls still fell
// back under a low per-minute rate limit — only whichever call happened
// to land in an open window succeeded. Retrying and serializing can only
// go so far against an account-level cap; the more effective fix is to
// simply need fewer calls. So these are now fetched via two combined
// calls instead of six: everything that only needs the company name in
// one call, everything that also needs the job description in another.
// Same per-section content and shape downstream — just assembled from
// fewer, larger AI responses instead of many small ones.
// ---------------------------------------------------------------------

function researchFallback(description) {
  return {
    headline: `[AI UPGRADE POINT] ${description} Wire ANTHROPIC_API_KEY with web search enabled to populate this automatically.`,
    bullets: [],
    sources: [],
  };
}

function sectionFromBundle(entry, sources) {
  if (!entry || !Array.isArray(entry.bullets) || entry.bullets.length === 0) return null;
  return { headline: entry.headline || "", bullets: entry.bullets, sources: sources || [] };
}

// Company overview + recent news + employee sentiment + social media —
// none of these need the job description, just the company name, so
// they're researched together in one web-search call.
async function companyBundle(companyName) {
  const fallbacks = {
    research: researchFallback(`A detailed company overview for "${companyName}" would appear here.`),
    recentNews: researchFallback(`A summary of recent news and press coverage of "${companyName}" would appear here.`),
    employeeSentiment: researchFallback(`A summary of what employees say about working at "${companyName}" (Glassdoor, Google, Indeed reviews) would appear here.`),
    socialMedia: researchFallback(`A rundown of "${companyName}"'s social media presence and recent activity would appear here.`),
  };
  if (!companyName || !companyName.trim() || !hasAnthropic()) return fallbacks;

  const result = await claudeJSON(
    `Research the company "${companyName}" in depth for someone about to interview there — search the web ` +
    `for current, real information and cover FOUR distinct angles as four separate sections:\n\n` +
    `1. COMPANY OVERVIEW (write 8-10 bullets): what they do and who they serve specifically; their size and ` +
    `structure (employee count, offices/locations, ownership — public, private, PE-backed, part of a ` +
    `group); their main products or services; their stated values or culture and how that actually shows ` +
    `up (not just marketing copy); who leads them (CEO/MD and other named leadership worth knowing); their ` +
    `recent trajectory — growth, funding, contraction, notable wins or setbacks; how they compare to their ` +
    `nearest competitors and their actual USP.\n\n` +
    `2. RECENT NEWS (write 5-8 bullets): recent news and press coverage from roughly the last 6-12 months — ` +
    `funding, leadership changes, launches, awards, restructuring, controversies. Each bullet should be one ` +
    `specific, dated item (name the date, people, or figures involved), not a vague summary. If there's ` +
    `genuinely little recent coverage, say so plainly in a single bullet rather than inventing news.\n\n` +
    `3. EMPLOYEE SENTIMENT (write 5-8 bullets): what current and former employees say — Glassdoor, Google ` +
    `reviews, Indeed, any genuine review source. The overall rating if available (e.g. "3.9/5 on Glassdoor ` +
    `from ~200 reviews"), the most recurring praise, the most recurring criticism, anything worth probing ` +
    `gently in the interview. Be balanced — don't sand off real criticism or exaggerate a handful of angry ` +
    `reviews into a pattern.\n\n` +
    `4. SOCIAL MEDIA (write 5-8 bullets): their social media presence — LinkedIn, Instagram, X/Twitter, ` +
    `TikTok, Facebook, whichever they're genuinely active on, with follower counts if findable, what tone ` +
    `comes through in their posts, and specific recent posts/campaigns/announcements worth knowing (name ` +
    `them specifically). Include the actual profile URLs you find.\n\n` +
    `Every bullet must be genuinely specific and concrete — names, numbers, dates, real detail — never vague ` +
    `filler like "they seem to value teamwork". If you genuinely can't find reliable information, leave that ` +
    `bullet out rather than guessing or padding. Never invent facts about a real company.\n\n` +
    `Return JSON in exactly this shape: {"companyOverview": {"headline": "one sentence framing", "bullets": ` +
    `[...]}, "recentNews": {"headline": "...", "bullets": [...]}, "employeeSentiment": {"headline": "...", ` +
    `"bullets": [...]}, "socialMedia": {"headline": "...", "bullets": [...]}}`,
    { webSearch: true, maxTokens: 6500 }
  );

  if (!result) return fallbacks;
  const sources = result.sources || [];
  return {
    research: sectionFromBundle(result.companyOverview, sources) || fallbacks.research,
    recentNews: sectionFromBundle(result.recentNews, sources) || fallbacks.recentNews,
    employeeSentiment: sectionFromBundle(result.employeeSentiment, sources) || fallbacks.employeeSentiment,
    socialMedia: sectionFromBundle(result.socialMedia, sources) || fallbacks.socialMedia,
  };
}

// Market & sector intelligence + role challenges — both need the job
// description as well as the company name, so they're researched
// together in a second web-search call.
async function marketAndChallengesBundle(companyName, jobDescription) {
  const fallbacks = {
    marketIntelligence: researchFallback(`A briefing on market and sector trends relevant to "${companyName}" and this role would appear here.`),
    roleChallenges: researchFallback(`Likely challenges facing this role at "${companyName}" (sector pressures, skills/labour shortages, etc.) would appear here.`),
  };
  if (!companyName || !companyName.trim() || !hasAnthropic()) return fallbacks;

  const result = await claudeJSON(
    `Research "${companyName}" and the role described below to cover TWO distinct angles as two separate ` +
    `sections:\n\n` +
    `1. MARKET & SECTOR INTELLIGENCE (write 5-8 bullets): current market and sector trends relevant to this ` +
    `company and role — economic pressure on the sector, regulatory change, technology shift, ` +
    `consumer/customer behaviour change, competitive dynamics — whatever is genuinely relevant right now, ` +
    `and how that context might shape what this interviewer actually cares about.\n\n` +
    `2. ROLE CHALLENGES (write 5-8 bullets): the real, current challenges someone would likely face in this ` +
    `specific role — sector-wide labour or skills shortages relevant to it, budget or economic pressure on ` +
    `this function, technology or tooling changes creating extra demands, regulatory or compliance ` +
    `pressure, talent retention/competition for this type of role, or anything specific to this company ` +
    `(recent restructuring, rapid growth strain, a known industry problem). Be realistic, not alarmist.\n\n` +
    `Every bullet must be genuinely specific and concrete, grounded in something you actually found via web ` +
    `search — never invent a trend or challenge that isn't real.\n\n` +
    `JOB DESCRIPTION:\n${jobDescription || "(not provided)"}\n\n` +
    `Return JSON in exactly this shape: {"marketIntelligence": {"headline": "one sentence framing", ` +
    `"bullets": [...]}, "roleChallenges": {"headline": "...", "bullets": [...]}}`,
    { webSearch: true, maxTokens: 2600 }
  );

  if (!result) return fallbacks;
  const sources = result.sources || [];
  return {
    marketIntelligence: sectionFromBundle(result.marketIntelligence, sources) || fallbacks.marketIntelligence,
    roleChallenges: sectionFromBundle(result.roleChallenges, sources) || fallbacks.roleChallenges,
  };
}

// ---------------------------------------------------------------------
// Opening pitch — Pitch Sandwich
// ---------------------------------------------------------------------

function pitchFillingFallback(jobDescription) {
  const jdWords = topKeywords(jobDescription, 8).slice(0, 4).join(", ");
  return `Professionally, [AI UPGRADE POINT: summarise the candidate's most relevant experience from their CV, `
    + `weighted toward what the job description emphasises most — this JD leans heavily on: ${jdWords || "[keywords]"}].`;
}

async function pitchSandwich({ candidateName, connectDetail, cvText, jobDescription, values }) {
  const bread1 = `A bit about me — I'm ${candidateName || "[name]"}${connectDetail ? `, ${connectDetail}` : " — [add a personal detail here, e.g. where you're based or an outside interest]"}.`;
  const bread2 = `In how I work, I value ${values && values.length ? values.join(" and ") : "[value 1] and [value 2]"}, `
    + `which means you'll get someone who [add what that looks like in behaviour].`;

  let filling = pitchFillingFallback(jobDescription);
  if (hasAnthropic() && cvText && jobDescription) {
    const result = await claudeText(
      `Write the "Filling" layer of a Pitch Sandwich (the "tell me about yourself" answer framework: ` +
      `Connect / Fit / Values). This layer covers top-line skills and proof, matched to the job description. ` +
      `Write 2-3 sentences, first person, starting with "Professionally, ...". Use only real experience from ` +
      `the CV below — never invent achievements. Weight it toward what this specific job description asks for.\n\n` +
      `JOB DESCRIPTION:\n${jobDescription}\n\nCV:\n${cvText}`,
      { maxTokens: 500 }
    );
    if (result && result.text) filling = result.text;
  }

  return { bread1, filling, bread2 };
}

// ---------------------------------------------------------------------
// STAR answers
// ---------------------------------------------------------------------

function draftStarAnswerHeuristic(question, transcript, basedOn) {
  const sentences = transcript.split(/(?<=[.!?])\s+/).filter(Boolean);
  const chunk = Math.max(1, Math.ceil(sentences.length / 4));
  const parts = [
    sentences.slice(0, chunk).join(" "),
    sentences.slice(chunk, chunk * 2).join(" "),
    sentences.slice(chunk * 2, chunk * 3).join(" "),
    sentences.slice(chunk * 3).join(" "),
  ];
  return {
    question,
    basedOn: basedOn || "",
    situation: parts[0] || "[AI UPGRADE POINT would restructure this from the transcript]",
    task: parts[1] || "",
    action: parts[2] || "",
    result: parts[3] || "",
    note: "Prototype split — a real model call (AI UPGRADE POINT) would rewrite this cleanly into S/T/A/R rather than chopping the transcript into quarters.",
  };
}

async function draftStarAnswer(question, transcript, basedOn) {
  if (!transcript || !transcript.trim()) {
    return { question, basedOn: basedOn || "", situation: "[No answer recorded yet]", task: "", action: "", result: "" };
  }
  if (!hasAnthropic()) return draftStarAnswerHeuristic(question, transcript, basedOn);

  const result = await claudeJSON(
    `Rewrite this rambling spoken interview answer into a clean STAR structure (Situation, Task, Action, ` +
    `Result). Use only what's actually said — don't invent details, numbers or outcomes that aren't there. ` +
    `Tidy up filler words and false starts, but keep it in the candidate's own voice and first person ("I"). ` +
    `If a part (e.g. Result) genuinely isn't covered in the transcript, say so honestly rather than making ` +
    `something up.\n\nQUESTION: ${question}\n\nTRANSCRIPT: ${transcript}\n\n` +
    `Return JSON: {"situation": "...", "task": "...", "action": "...", "result": "..."}`
  );

  if (!result) return draftStarAnswerHeuristic(question, transcript, basedOn);
  return {
    question,
    basedOn: basedOn || "",
    situation: result.situation || "—",
    task: result.task || "—",
    action: result.action || "—",
    result: result.result || "—",
  };
}

// Rewrites every recorded answer in ONE Claude call instead of one call
// per question — a candidate answering 5 questions used to mean 5 more
// Claude calls on top of the research calls, which was a big share of
// the total load on a rate-limited account. Skips the AI call entirely
// if nothing was actually recorded (no point spending a call on "[No
// answer recorded yet]"), and falls back per-answer to the heuristic
// split if the batched call fails.
async function draftStarAnswersBatch(answers) {
  const list = answers || [];
  const results = new Array(list.length);
  const toProcess = [];
  list.forEach((a, idx) => {
    if (!a.transcript || !a.transcript.trim()) {
      results[idx] = { question: a.question, basedOn: a.basedOn || "", situation: "[No answer recorded yet]", task: "", action: "", result: "" };
    } else {
      toProcess.push({ idx, question: a.question, transcript: a.transcript, basedOn: a.basedOn });
    }
  });

  if (toProcess.length === 0) return results;
  if (!hasAnthropic()) {
    toProcess.forEach(({ idx, question, transcript, basedOn }) => {
      results[idx] = draftStarAnswerHeuristic(question, transcript, basedOn);
    });
    return results;
  }

  const result = await claudeJSON(
    `Rewrite each of these rambling spoken interview answers into a clean STAR structure (Situation, Task, ` +
    `Action, Result). Use only what's actually said in each transcript — don't invent details, numbers or ` +
    `outcomes that aren't there. Tidy up filler words and false starts, but keep it in the candidate's own ` +
    `voice and first person ("I"). If a part genuinely isn't covered in a transcript, say so honestly rather ` +
    `than making something up. Treat each answer completely independently — don't blend details between ` +
    `them.\n\n` +
    toProcess.map((a, i) => `ANSWER ${i + 1}\nQUESTION: ${a.question}\nTRANSCRIPT: ${a.transcript}`).join("\n\n") +
    `\n\nReturn JSON: {"answers": [{"situation": "...", "task": "...", "action": "...", "result": "..."}, ...]} ` +
    `with exactly ${toProcess.length} items, in the same order as the answers listed above.`,
    { maxTokens: Math.min(4000, 350 * toProcess.length + 400) }
  );

  if (!result || !Array.isArray(result.answers) || result.answers.length !== toProcess.length) {
    toProcess.forEach(({ idx, question, transcript, basedOn }) => {
      results[idx] = draftStarAnswerHeuristic(question, transcript, basedOn);
    });
    return results;
  }

  toProcess.forEach(({ idx, question, basedOn }, i) => {
    const r = result.answers[i] || {};
    results[idx] = {
      question,
      basedOn: basedOn || "",
      situation: r.situation || "—",
      task: r.task || "—",
      action: r.action || "—",
      result: r.result || "—",
    };
  });
  return results;
}

// ---------------------------------------------------------------------
// Questions to ask them — templated, no AI needed (already JD-personalised
// via the company name; see lib/questionBank.js for the AI-matched
// competency questions asked earlier in the flow).
// ---------------------------------------------------------------------

function questionsToAsk(companyName) {
  const name = companyName || "the company";
  return {
    "Type 1 — About the company": [
      `What's driven ${name}'s growth, and where do you see the next phase coming from?`,
      `What's working well in the current strategy for this function, and where do you feel it's falling short?`,
    ],
    "Type 2 — About the job": [
      `What would you want this role to have delivered in the first 90 days?`,
      `What tools and systems does the team use day to day?`,
    ],
    "Type 3 — About the interviewers": [
      `What drew you to ${name}, and what's kept you here?`,
      `What's the biggest challenge you personally face in your role right now?`,
    ],
    "Type 4 — About you, in this role": [
      `Based on our conversation so far, is there anything you'd like me to clarify about my fit for this role?`,
    ],
  };
}

// Matched to the guide's "Framework 04 — STAR Stories": predict likely
// questions from the job spec, then prepare 2–3 versatile stories that
// cover most scenarios, told in four parts.
const STAR_GUIDE = {
  intro: "\"Tell me about a time when…\" — predict likely questions from the job spec, then prepare 2–3 versatile stories that cover most scenarios. Tell each one in four parts.",
  steps: [
    { letter: "S", label: "Situation", explanation: "The context. Set the scene briefly — a sentence or two, not the whole backstory." },
    { letter: "T", label: "Task", explanation: "What you were specifically responsible for delivering. Not the team's goal — yours." },
    { letter: "A", label: "Action", explanation: "What you did — the actual steps. This is the part that gets scored, so don't rush it." },
    { letter: "R", label: "Result", explanation: "Measurable outcomes. Numbers if you can — even a rough estimate beats no number at all." },
  ],
  tips: [
    "Own it: say \"I,\" not \"we\" — the team did things, but the panel is hiring you. Make your specific actions visible.",
    "Action is the money: don't rabbit-hole in the Situation — walk them through your process clearly, the \"A\" is what they're scoring.",
    "Pro move: build your 2–3 stories around the most-cited competencies in the JD (leadership, problem-solving, conflict, delivering under pressure). One good story can answer three different questions.",
  ],
};

// Shown alongside the sample competency questions (both in the app and
// in the report) so it's clear these are illustrative, not a prediction
// of exactly what will be asked on the day.
const QUESTIONS_FOOTNOTE = "These are a sample of the type of competency-based questions this role is likely to attract, based on the job description — not a guaranteed or exhaustive list of what you'll actually be asked. Use them to build 2–3 versatile STAR stories (see above) that can flex to cover whatever comes up.";

// A rough "how much of the JD does this CV genuinely cover" score, used
// for the skills-match visual. Deliberately simple (matched vs. matched+
// gaps) rather than weighted — it's a supporting visual, not the report's
// main analysis, which is the actual bullet-by-bullet Cake + Cherry text.
function skillsMatchScore(gaps) {
  const matched = (gaps.matchedStrengths || []).length;
  const gapCount = (gaps.developmentAreas || []).length;
  const total = matched + gapCount;
  const percent = total > 0 ? Math.round((matched / total) * 100) : null;
  return { matched, gaps: gapCount, total, percent };
}

// ---------------------------------------------------------------------
// Collect every real citation gathered across the research sections into
// one de-duped, ordered list — used to render a single consolidated
// "Sources & References" section at the end of the report (in addition
// to the inline links shown under each section), so a candidate — or
// Neil, spot-checking a report — can see everything the AI actually
// drew on in one place.
// ---------------------------------------------------------------------
function collectAllSources(sectionsInOrder) {
  const seen = new Set();
  const all = [];
  sectionsInOrder.forEach(({ label, section }) => {
    (section && section.sources ? section.sources : []).forEach((s) => {
      if (s.url && !seen.has(s.url)) {
        seen.add(s.url);
        all.push({ url: s.url, title: s.title || s.url, section: label });
      }
    });
  });
  return all;
}

// ---------------------------------------------------------------------
// Assemble the report. This used to fire up to 9-13 separate Claude calls
// per report (6 research sections + gap analysis + pitch + one call per
// STAR answer). Live testing on Neil's actual Anthropic account showed
// that even serialized one-at-a-time with retries (lib/aiClients.js),
// that many calls was still too much load for a low per-minute rate
// limit — most calls would still fall back. Retrying/serializing alone
// can't out-run an account-level cap, so this now uses far fewer, larger
// calls instead: the 6 research sections are fetched via 2 combined
// calls (companyBundle, marketAndChallengesBundle), and all STAR answers
// via 1 batched call — bringing a typical report down to about 5 Claude
// calls total instead of 9-13, on top of the existing concurrency/retry
// safety net.
// ---------------------------------------------------------------------

async function generateReport(input) {
  const {
    candidateName, companyName, connectDetail, values,
    jobDescription, cvText, answers,
  } = input;

  const [companyBundleResult, marketBundleResult, gaps, pitch, starAnswers, cover] = await Promise.all([
    companyBundle(companyName),
    marketAndChallengesBundle(companyName, jobDescription),
    gapAnalysis(jobDescription, cvText, companyName),
    pitchSandwich({ candidateName, connectDetail, cvText, jobDescription, values }),
    draftStarAnswersBatch(answers || []),
    coverArt({ companyName, jobDescription }),
  ]);

  const { research, recentNews: news, employeeSentiment: sentiment, socialMedia: social } = companyBundleResult;
  const { marketIntelligence: market, roleChallenges: challenges } = marketBundleResult;

  const questions = questionsToAsk(companyName);

  // hasAnthropic() only proves a key is SET, not that it's actually working
  // — a bad/expired/rate-limited key still passes that check, every call
  // silently falls back, and the UI would keep claiming "(AI-powered)"
  // while quietly serving placeholder text. Check whether at least one
  // web-search section that only succeeds with a real, working key
  // actually returned real content, so the status line tells the truth.
  const researchSections = [
    { label: "Company overview", section: research },
    { label: "Employee sentiment", section: sentiment },
    { label: "Social media presence", section: social },
    { label: "Market & sector intelligence", section: market },
    { label: "Recent news & press", section: news },
    { label: "Role challenges", section: challenges },
  ];
  const aiActuallyWorked = hasAnthropic() && researchSections.some((s) => Array.isArray(s.section.bullets) && s.section.bullets.length > 0);
  const allSources = collectAllSources(researchSections);

  return {
    candidateName,
    companyName,
    generatedAt: new Date().toISOString(),
    aiPowered: aiActuallyWorked,
    aiKeyPresent: hasAnthropic(),
    cover,
    research,
    employeeSentiment: sentiment,
    socialMedia: social,
    marketIntelligence: market,
    recentNews: news,
    roleChallenges: challenges,
    pitch,
    gapAnalysis: gaps,
    skillsMatch: skillsMatchScore(gaps),
    starGuide: STAR_GUIDE,
    starAnswers,
    questionsFootnote: QUESTIONS_FOOTNOTE,
    questionsToAsk: questions,
    allSources,
  };
}

module.exports = { generateReport, topKeywords, gapAnalysisHeuristic, STAR_GUIDE, QUESTIONS_FOOTNOTE };
