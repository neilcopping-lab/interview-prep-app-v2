/**
 * Shared, lazily-created API clients. Both read their key from an
 * environment variable — set in Render's Environment tab, never in code.
 *
 * hasAnthropic() / hasOpenAI() let the rest of the app check whether a key
 * is configured before attempting a real call, so it can fall back to the
 * prototype's rule-based behaviour instead of crashing when a key is
 * missing (e.g. running locally without one set).
 */

let anthropicClient = null;
let openaiClient = null;

function hasAnthropic() {
  return !!process.env.ANTHROPIC_API_KEY;
}

function hasOpenAI() {
  return !!process.env.OPENAI_API_KEY;
}

function getAnthropic() {
  if (!hasAnthropic()) return null;
  if (!anthropicClient) {
    const Anthropic = require("@anthropic-ai/sdk");
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropicClient;
}

function getOpenAI() {
  if (!hasOpenAI()) return null;
  if (!openaiClient) {
    const OpenAI = require("openai");
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClient;
}

// The model used for all report-writing calls. Overridable via env var
// without a code change if you want to try a different one.
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";
const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || "gpt-4o-transcribe";
const IMAGE_MODEL = process.env.IMAGE_MODEL || "gpt-image-1";

// ---------------------------------------------------------------------
// Cover art generation (OpenAI images). Returns a PNG Buffer, or null on
// any failure/missing key — the report should never break because the
// "nice to have" bespoke image couldn't be generated. This uses OpenAI
// (not Claude) since Anthropic doesn't offer image generation.
// ---------------------------------------------------------------------
async function generateCoverImage(prompt, { size = "1536x1024" } = {}) {
  if (!hasOpenAI()) return null;
  try {
    const client = getOpenAI();
    const params = { model: IMAGE_MODEL, prompt, size, n: 1 };
    // dall-e-3 needs response_format explicitly set to get base64 back
    // (it defaults to a URL); gpt-image-1 always returns base64 and
    // doesn't accept this param, so only add it for the dall-e family.
    if (IMAGE_MODEL.startsWith("dall-e")) params.response_format = "b64_json";
    const response = await client.images.generate(params);
    const b64 = response.data && response.data[0] && response.data[0].b64_json;
    if (!b64) return null;
    return Buffer.from(b64, "base64");
  } catch (err) {
    console.error("[generateCoverImage] falling back (no image):", err.message);
    return null;
  }
}

// ---------------------------------------------------------------------
// Shared Claude call helpers, used by both lib/reportGenerator.js and
// lib/questionBank.js. Both return null on any failure (missing key,
// network error, bad response) so callers can fall back cleanly instead
// of crashing.
// ---------------------------------------------------------------------

// Prepended to every prompt. This is a paid product — someone is spending
// £45 (or £74 with the coaching add-on) on this report, so the bar is
// "genuinely useful and specific," not "plausible-sounding AI filler."
// Explicitly telling the model that tends to measurably improve output
// quality and tone versus a bare instruction.
const QUALITY_PREAMBLE = "You're writing part of a paid interview preparation product — a real person has paid for this and is relying on it to walk into a real interview well prepared. Write like an experienced, specific, no-nonsense recruiter, not like generic AI career advice. Be concrete. Avoid vague filler phrases (\"leverage your skills\", \"showcase your passion\", \"in today's competitive job market\"). If you don't have enough information to say something specific and true, say less rather than padding it out.\n\n";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A single report generation now fires up to ~9 Claude calls in parallel
// (5 of them using web search, which is slower and more likely to bump
// into per-minute rate limits on a lower API tier). A 429 there used to
// mean that section silently fell back to placeholder text — which looked
// like a broken feature rather than a transient limit. Retry a couple of
// times with backoff before giving up, but only for rate-limit/overload
// errors — a genuinely bad request should fail fast, not retry.
function isRetryable(err) {
  const status = err && (err.status || err.statusCode);
  const msg = (err && err.message || "").toLowerCase();
  return status === 429 || status === 529 || msg.includes("rate_limit") || msg.includes("overloaded");
}

// ---------------------------------------------------------------------
// Concurrency limiter. A single report used to fire ~9 Claude calls in
// parallel via Promise.all, which on a lower API tier tripped per-minute
// rate limits — some sections would 429, retry a couple of times, still
// fail, and silently fall back to placeholder text. Retries alone weren't
// enough because the *offered load* was still too high.
//
// This queue caps how many Claude requests are actually in flight at once,
// regardless of how many the caller kicks off "simultaneously" — extra
// calls just wait their turn. Report generation stays roughly as fast
// (calls still overlap, just fewer at a time) but stops overwhelming the
// rate limit.
// ---------------------------------------------------------------------
// Live testing on Neil's actual Render deployment (2 in flight, 4 retries
// with backoff) still showed 5 of 6 web-search research calls falling
// back in a single report — but the LAST call to get a queue slot was the
// one that succeeded, which is the signature of a genuinely low
// per-minute rate limit on the Anthropic account itself (the first calls
// burn the quota and 429 repeatedly; by the time a later call gets its
// turn, enough real time has passed for the window to reset). No amount
// of in-process concurrency tuning can out-run an account-level cap, but
// going fully serial (one Claude call in flight at a time) gives each
// call the best possible chance against a strict per-minute limit. This
// makes report generation slower — if the account's rate limit is the
// bottleneck, check the tier/limits at console.anthropic.com and consider
// requesting an increase, since that's the real fix.
const MAX_CONCURRENT_CLAUDE_CALLS = 1;
let activeClaudeCalls = 0;
const claudeWaitQueue = [];

function acquireClaudeSlot() {
  if (activeClaudeCalls < MAX_CONCURRENT_CLAUDE_CALLS) {
    activeClaudeCalls++;
    return Promise.resolve();
  }
  return new Promise((resolve) => claudeWaitQueue.push(resolve));
}

// A small pause before waking the next queued call, rather than firing it
// the instant a slot frees up. Back-to-back calls with zero gap tend to
// land in the same rate-limit window as whatever just failed; a brief
// pace-setting delay spreads requests out over time instead of bursting.
const SLOT_HANDOFF_DELAY_MS = 400;

function releaseClaudeSlot() {
  activeClaudeCalls--;
  const next = claudeWaitQueue.shift();
  if (next) {
    setTimeout(() => {
      activeClaudeCalls++;
      next();
    }, SLOT_HANDOFF_DELAY_MS);
  }
}

// Returns { text, sources } — never a bare string — so every caller has
// access to real citation URLs when web search was used. `sources` is
// always an array (empty when web search wasn't enabled or nothing was
// cited); callers that don't care about sources can just destructure
// `.text` and ignore it.
async function claudeText(prompt, { webSearch = false, maxTokens = 1024 } = {}) {
  const client = getAnthropic();
  if (!client) return null;

  await acquireClaudeSlot();
  try {
    const MAX_ATTEMPTS = 4;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const response = await client.messages.create({
          model: CLAUDE_MODEL,
          max_tokens: maxTokens,
          messages: [{ role: "user", content: QUALITY_PREAMBLE + prompt }],
          ...(webSearch ? { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }] } : {}),
        });

        const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
        if (!text) return null;

        // Pull real source URLs out of any citations Claude attached to its
        // text blocks (only present when webSearch was used). De-duped by
        // URL, capped so a section can't end up with 20 near-identical links.
        const seen = new Set();
        const sources = [];
        response.content.forEach((block) => {
          if (block.type !== "text" || !Array.isArray(block.citations)) return;
          block.citations.forEach((c) => {
            if (c.url && !seen.has(c.url)) {
              seen.add(c.url);
              sources.push({ url: c.url, title: c.title || c.url });
            }
          });
        });

        return { text, sources: sources.slice(0, 6) };
      } catch (err) {
        const willRetry = attempt < MAX_ATTEMPTS && isRetryable(err);
        console.error(`[claudeText] attempt ${attempt}${willRetry ? ", retrying" : ", falling back"}:`, err.message);
        if (!willRetry) return null;
        // 800ms, 1600ms, 3200ms — rate-limit windows reset per-minute, so a
        // longer, patient backoff clears more of them than a fast one.
        await sleep(800 * 2 ** (attempt - 1));
      }
    }
    return null;
  } finally {
    releaseClaudeSlot();
  }
}

// Fixes the single most common way Claude's raw JSON output breaks strict
// JSON.parse: a literal, unescaped control character (a real line break or
// tab) sitting inside a string value, rather than the escaped \n / \t
// JSON requires. This walks the string character-by-character (rather
// than a regex with a unicode escape range, which is easy to mangle) and
// swaps real control characters for their escaped equivalents — a light,
// targeted pass, not a full parser, but it resolves the overwhelming
// majority of real "Unterminated string" errors seen in production
// without needing a heavier JSON-repair dependency.
function sanitizeJsonText(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 10) { out += "\\n"; continue; } // literal newline -> \n
    if (code === 9) { out += "\\t"; continue; } // literal tab -> \t
    if (code === 13) { continue; } // literal carriage return -> drop
    if (code < 32) { continue; } // any other stray control character -> drop
    out += text[i];
  }
  return out;
}

// Same as claudeText, but asks for (and parses) a JSON reply. Pass
// { webSearch: true } to ground it in real search results — when used,
// the returned object carries a `sources` array (real cited URLs)
// alongside whatever fields the prompt asked for. Returns null on any
// failure so callers can fall back to their heuristic version.
//
// Production logs showed Claude occasionally returning JSON with a stray
// unescaped quote or literal line break inside a bullet's text — the
// response itself was good, useful content, but JSON.parse rejected the
// whole thing outright and the caller fell back to placeholder text. Two
// layers of defence against that: (1) a light sanitisation pass before
// giving up on a parse, and (2) if that still fails, one fresh retry of
// the whole call — since this is a probabilistic slip, not a systematic
// one, a second generation very rarely repeats the same mistake.
async function claudeJSON(prompt, { maxTokens = 1024, webSearch = false } = {}) {
  const fullPrompt =
    `${prompt}\n\nRespond with ONLY valid JSON, no markdown code fences, no commentary before or after it. ` +
    `This matters: every double-quote character and line break that appears INSIDE a string value must be properly ` +
    `escaped (\\" and \\n) so the JSON parses correctly — never include a literal, unescaped line break or ` +
    `quotation mark inside a string value.`;

  const MAX_JSON_ATTEMPTS = 2;
  for (let attempt = 1; attempt <= MAX_JSON_ATTEMPTS; attempt++) {
    const result = await claudeText(fullPrompt, { maxTokens, webSearch });
    if (!result || !result.text) return null;

    const cleaned = result.text.replace(/^```(json)?/i, "").replace(/```$/, "").trim();
    try {
      const parsed = JSON.parse(cleaned);
      if (webSearch) parsed.sources = result.sources;
      return parsed;
    } catch (err) {
      try {
        const parsed = JSON.parse(sanitizeJsonText(cleaned));
        if (webSearch) parsed.sources = result.sources;
        return parsed;
      } catch (err2) {
        const willRetry = attempt < MAX_JSON_ATTEMPTS;
        console.error(`[claudeJSON] attempt ${attempt} could not parse response${willRetry ? ", retrying with a fresh call" : ", falling back"}:`, err2.message);
      }
    }
  }
  return null;
}

module.exports = {
  hasAnthropic, hasOpenAI, getAnthropic, getOpenAI, CLAUDE_MODEL, TRANSCRIBE_MODEL, IMAGE_MODEL,
  claudeText, claudeJSON, generateCoverImage,
};
