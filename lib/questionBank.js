/**
 * Competency question selection.
 *
 * LIVE MODE (ANTHROPIC_API_KEY set): Claude reads the actual job description
 * and writes bespoke competency questions in the interviewer's own
 * language — grounded in what this specific role actually asks for, not
 * picked from a fixed list. Each question comes back with a short
 * "basedOn" note naming the specific JD requirement it tests, so the
 * alignment is visible, not just claimed.
 *
 * FALLBACK MODE (no key, or the call fails): rather than scoring the whole
 * job description against the question bank in one go (which tends to
 * cluster around whichever single theme repeats most often and miss
 * everything else), this first pulls out the JD's actual distinct
 * requirement lines, then matches each one individually to the best-fit
 * bank question — so a JD with five different responsibilities gets five
 * differently-grounded questions, each visibly tied to the specific line
 * that triggered it.
 */

const { hasAnthropic, claudeJSON } = require("./aiClients");

const QUESTION_BANK = [
  {
    question: "Tell me about a time you had to influence a senior stakeholder who didn't initially agree with you.",
    tags: ["stakeholder", "senior", "influence", "persuade", "buy-in", "director", "leadership", "ceo", "board"],
  },
  {
    question: "Describe a time a campaign or project didn't go to plan — what happened, and what did you do?",
    tags: ["campaign", "project", "delivery", "deadline", "launch", "marketing", "strategy"],
  },
  {
    question: "Tell me about a time you managed a difficult relationship with an external agency or supplier.",
    tags: ["agency", "supplier", "vendor", "partner", "external", "procurement", "contractor"],
  },
  {
    question: "Describe a time you received tough feedback and how you responded.",
    tags: ["feedback", "performance", "development", "review", "coaching", "improve"],
  },
  {
    question: "Tell me about a time you had to make a decision quickly with incomplete information.",
    tags: ["fast-paced", "pressure", "deadline", "decision", "ambiguity", "urgent", "fast paced"],
  },
  {
    question: "Tell me about a time you led a team through a period of change or uncertainty.",
    tags: ["team", "manage", "lead", "leadership", "mentor", "coach", "line manager", "supervisor", "change"],
  },
  {
    question: "Describe a time you had to build something from limited resources.",
    tags: ["build", "launch", "new", "start-up", "startup", "from scratch", "zero", "growth"],
  },
  {
    question: "Give an example of managing multiple competing priorities at once.",
    tags: ["multiple", "priorities", "manage", "organise", "organised", "organisation", "deadlines", "workload"],
  },
  {
    question: "Tell me about a time you championed diversity or inclusion at work.",
    tags: ["diversity", "inclusion", "edi", "equality", "inclusive"],
  },
  {
    question: "Tell me about a time you had to quickly learn a new skill or tool to do your job well.",
    tags: ["learn", "training", "upskill", "adapt", "new tool", "software", "systems", "cms", "crm", "analytics", "tiktok", "adobe"],
  },
  {
    question: "Tell me about a time you had to resolve a disagreement or conflict at work.",
    tags: ["conflict", "disagreement", "difficult conversation", "mediate", "resolve"],
  },
  {
    question: "Describe a time you came up with a genuinely creative or innovative idea that worked.",
    tags: ["creative", "innovative", "idea", "campaign", "content", "brand", "design"],
  },
  {
    question: "Tell me about a time data or analytics changed a decision you made.",
    tags: ["data", "analytics", "metrics", "kpi", "performance", "reporting", "insight", "seo", "ppc"],
  },
  {
    question: "Describe a time you went out of your way to solve a problem for a client or customer.",
    tags: ["customer", "client", "service", "satisfaction", "account", "relationship"],
  },
  {
    question: "Tell me about a time you managed a budget or made a commercially-driven decision.",
    tags: ["budget", "commercial", "revenue", "cost", "profit", "roi", "sales", "target"],
  },
  {
    question: "What's your proudest achievement, and why?",
    tags: [], // generic — always eligible as a fallback/filler
  },
];

// Tags common enough to show up in almost any JD line ("manage", "lead",
// "team"...) — left in each bank entry's tag list for the whole-JD
// fallback pass (where broader signal is fine), but excluded from the
// per-line matching in bestBankMatch, where they'd otherwise let a weak,
// generic word win a specific line over a more precise keyword (e.g. a
// line mentioning both "manage" and "budget" should map to the budget
// question, not just whichever generic-tagged entry happens to be
// checked first).
const GENERIC_TAGS = new Set(["manage", "lead", "team", "work", "working", "new", "build", "own", "change", "growth", "launch"]);

function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// Words that suggest a line is describing an actual responsibility/
// requirement rather than boilerplate ("apply now", "we are an equal
// opportunities employer", a benefits list, etc.) — used to rank JD lines
// so the phrases picked to ground questions are the substantive ones.
const REQUIREMENT_SIGNAL = new RegExp(
  "\\b(manag|lead|leadership|deliver|develop|responsib|experience (of|in|with)|" +
  "ability to|drive|driving|build|building|own|owning|ownership|collaborat|" +
  "coordinat|negotiat|analy|budget|stakeholder|report|plan|execut|oversee|" +
  "ensure|support|contribut|achiev|grow|improv|implement|communicat|present|" +
  "monitor|resolve|handl|priorit|mentor|train|campaign|strateg|customer|" +
  "client|kpi|target|sales|revenue|complian|risk|quality|process|project|" +
  "cross-functional|forecast|recruit|hire|onboard)\\b", "i"
);

// Splits a job description into its real, individual requirement lines
// rather than treating it as one bag of keywords. Handles both bulleted
// JDs (most common — one requirement per line) and JDs pasted as dense
// paragraphs (falls back to sentence-splitting).
function extractRequirementPhrases(jobDescription, maxPhrases = 10) {
  const text = (jobDescription || "").trim();
  if (!text) return [];

  const rawLines = text.split(/\r?\n/).map((l) => l.replace(/^[\s\-•*•\d.)]+/, "").trim()).filter(Boolean);
  // A JD pasted as continuous prose won't have useful line breaks — if we
  // don't have at least a handful of distinct lines, split into sentences
  // instead so we're still working with individual claims, not one blob.
  const candidates = rawLines.length >= 4
    ? rawLines
    : text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);

  const seen = new Set();
  const scored = [];
  candidates.forEach((line, idx) => {
    const words = line.split(/\s+/).filter(Boolean);
    if (words.length < 4 || words.length > 30) return; // too short to be a real requirement, or too long to quote cleanly
    const key = line.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 50);
    if (!key || seen.has(key)) return;
    seen.add(key);
    const matches = line.match(new RegExp(REQUIREMENT_SIGNAL, "gi")) || [];
    if (matches.length === 0) return; // skip boilerplate lines with no real signal
    scored.push({ line: line.replace(/\s+/g, " ").replace(/[:.;]+$/, ""), score: matches.length, idx });
  });

  // Highest-signal lines first; original JD order as a tiebreaker so
  // results stay stable and readable rather than jumping around.
  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return scored.slice(0, maxPhrases).map((s) => truncatePhrase(s.line));
}

function truncatePhrase(phrase, maxLen = 100) {
  if (phrase.length <= maxLen) return phrase;
  const cut = phrase.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut) + "…";
}

// Finds which bank question best fits a single JD line (not the whole
// document) — this is what lets five different requirement lines produce
// five differently-grounded questions instead of all five clustering
// around whichever theme happens to repeat most across the full JD.
function bestBankMatch(phrase, usedQuestions) {
  const phraseText = " " + tokenize(phrase).join(" ") + " ";
  let best = null;
  let bestScore = 0;
  QUESTION_BANK.forEach((entry) => {
    if (usedQuestions.has(entry.question) || entry.tags.length === 0) return;
    // Weight by tag length, not just match count — a specific keyword like
    // "budget" should outweigh a generic one like "manage" so a phrase
    // mentioning both maps to the more precise question. Generic tags are
    // excluded entirely here (see GENERIC_TAGS) so a line only matches on
    // them when it has no more specific signal to go on.
    const specificTags = entry.tags.filter((t) => !GENERIC_TAGS.has(t.toLowerCase()));
    const tagsToScore = specificTags.length ? specificTags : entry.tags;
    const score = tagsToScore.reduce((sum, t) => {
      const hit = phraseText.includes(" " + t.toLowerCase() + " ") || phraseText.includes(t.toLowerCase());
      return hit ? sum + t.length : sum;
    }, 0);
    if (score > bestScore) { bestScore = score; best = entry; }
  });
  return bestScore > 0 ? best : null;
}

function selectQuestionsHeuristic(jobDescription, count = 5) {
  const usedQuestions = new Set();
  const results = [];

  // Pass 1 — ground each question in a specific, real JD requirement line.
  const phrases = extractRequirementPhrases(jobDescription, count * 3);
  phrases.forEach((phrase) => {
    if (results.length >= count) return;
    const match = bestBankMatch(phrase, usedQuestions);
    if (!match) return;
    usedQuestions.add(match.question);
    results.push({ question: match.question, basedOn: phrase, matchedOn: match.tags });
  });

  // Pass 2 — if the JD didn't yield enough distinct, matchable lines (e.g.
  // it's short, or written unusually), fall back to scoring the bank
  // against the whole JD as before, to fill any remaining slots.
  if (results.length < count) {
    const jdTokens = tokenize(jobDescription);
    const jdText = " " + jdTokens.join(" ") + " ";
    const scored = QUESTION_BANK
      .filter((e) => !usedQuestions.has(e.question))
      .map((entry) => {
        const score = entry.tags.filter((t) => jdText.includes(" " + t.toLowerCase() + " ") || jdText.includes(t.toLowerCase())).length;
        return { ...entry, score };
      })
      .sort((a, b) => b.score - a.score);
    for (const s of scored) {
      if (results.length >= count) break;
      results.push({ question: s.question, basedOn: "", matchedOn: s.tags.filter((t) => jdText.includes(t.toLowerCase())) });
      usedQuestions.add(s.question);
    }
  }

  // Always leave room for the generic "proudest achievement" closer if
  // there's space and it isn't already in.
  const hasGeneric = results.some((r) => r.question.startsWith("What's your proudest"));
  if (!hasGeneric && results.length === count && count > 1) {
    const generic = QUESTION_BANK.find((q) => q.tags.length === 0);
    results[results.length - 1] = { question: generic.question, basedOn: "", matchedOn: [] };
  }

  return results.slice(0, count);
}

// If the model ignores the "no preamble" instruction and still front-loads
// a sentence or two of scene-setting before the actual question, this
// finds the real question-opening phrase and strips everything before it,
// rather than showing the candidate a wall of text with the question
// buried at the end. Falls back to the original text untouched if no
// recognisable opener is found (better a slightly long question than a
// silently mangled one).
const QUESTION_OPENERS = [
  "tell me about a time", "describe a time", "describe a situation",
  "give me an example", "give an example", "walk me through a time",
  "what's your", "what is your", "how did you", "how do you",
];
function stripPreamble(question) {
  const q = (question || "").trim();
  const lower = q.toLowerCase();
  let earliest = -1;
  QUESTION_OPENERS.forEach((opener) => {
    const idx = lower.indexOf(opener);
    if (idx > 0 && (earliest === -1 || idx < earliest)) earliest = idx;
  });
  if (earliest > 0) {
    const before = q.slice(0, earliest).trim();
    // Only strip if what comes before is a genuine, complete sentence
    // (ends in . ! or ?) — a real preamble paragraph does that. A short
    // context clause joined by a dash or comma (e.g. "You'll own a £750k
    // budget across paid and organic channels — how did you decide where
    // it went?") is one well-formed sentence, not a preamble, and the
    // clause before the dash is what makes "it"/"the money" mean anything
    // — stripping it left fragments like "How did you keep it on track?"
    // with no referent, which is exactly what broke question quality here.
    if (/[.!?]$/.test(before)) {
      const trimmed = q.slice(earliest);
      return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
    }
  }
  return q;
}

async function selectQuestions(jobDescription, count = 5) {
  if (!hasAnthropic()) return selectQuestionsHeuristic(jobDescription, count);

  const result = await claudeJSON(
    `You're a senior recruiter writing competency-based interview questions for the role described below. ` +
    `Write ${count} questions that a real interviewer would plausibly ask for THIS specific role.\n\n` +
    `ALIGNMENT IS THE WHOLE POINT: every question must trace back to ONE specific, distinct line or ` +
    `requirement in the job description below — a named responsibility, a specific tool or process, a type ` +
    `of stakeholder, a named pressure or metric. Read the JD closely and pick ${count} DIFFERENT requirements ` +
    `to ground questions in (not the same theme repeated) — if the JD lists five distinct responsibilities, ` +
    `a candidate should be able to see each question map to a different one of them. Do not write a question ` +
    `that could just as easily apply to any unrelated job — if you can't tie it to something specific in ` +
    `this JD, don't include it.\n\n` +
    `Use natural interview phrasing ("Tell me about a time...", "Describe a situation where...", "Give me ` +
    `an example of..."). Do not write questions about the candidate's CV — you only have the job description, ` +
    `not their background.\n\n` +
    `CRITICAL FORMAT RULE for the "question" field: ONLY the question itself — one sentence, starting ` +
    `directly with the question phrasing. Do NOT prefix it with scene-setting, a context paragraph, an ` +
    `explanation of why you're asking, or a restatement of the job description — a candidate should be able ` +
    `to read it in one breath, the way a real interviewer would actually say it out loud. Put the JD grounding ` +
    `in the separate "basedOn" field instead, not in the question.\n\n` +
    `JOB DESCRIPTION:\n${jobDescription}\n\n` +
    `Return JSON: {"questions": [{"question": "...", "basedOn": "under 12 words, plainly naming the specific ` +
    `JD requirement/line this question tests"}, ...]} with exactly ${count} items.`
  );

  if (!result || !Array.isArray(result.questions) || result.questions.length === 0) {
    return selectQuestionsHeuristic(jobDescription, count);
  }
  // Tolerate the model returning plain strings instead of {question, basedOn}
  // objects — still usable, just without the alignment note.
  const cleaned = result.questions.slice(0, count).map((q) => {
    if (typeof q === "string") return { question: stripPreamble(q), basedOn: "", matchedOn: [] };
    return { question: stripPreamble(q.question || ""), basedOn: truncatePhrase((q.basedOn || "").trim(), 90), matchedOn: [] };
  }).filter((q) => q.question);
  return cleaned.length ? cleaned : selectQuestionsHeuristic(jobDescription, count);
}

module.exports = { QUESTION_BANK, selectQuestions, selectQuestionsHeuristic, extractRequirementPhrases };
