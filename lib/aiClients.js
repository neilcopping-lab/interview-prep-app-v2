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
const QUALITY_PREAMBLE = "You're writing part of a paid interview preparation product — a real person has paid for this and is relying on it to walk into a real interview well prepared. Write like an experienced, specific, no-nonsense recruiter, not like generic AI career advice. Be concrete. Avoid vague filler phrases (\"leverage your skills\", \"showcase your passion\", \"in today's competitive job market\"). If you don't have enough information to say something specific and true, say less rather than padding it out. When you reference something you found via web search, name the source naturally in the sentence itself (e.g. \"according to Glassdoor...\") written as plain prose. The one thing to avoid is writing your own literal citation-tag syntax as visible text, such as <cite index=\"...\">...</cite> — that specific pattern breaks this product's JSON output. Do not let that instruction discourage you from citing sources at all; naming them in plain words is exactly what we want.\n\n";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Claude sometimes writes its own inline pseudo-citation markup — literal
// <cite index="20-12,20-13">...</cite> tags — directly into the prose text
// of a web-search-grounded response, on top of (or instead of) using the
// API's real structured citation metadata that lib/reportGenerator.js
// already reads separately via block.citations. Left in place this is a
// double problem: it's an ugly, unprofessional artefact in a paying
// customer's report, and the tag's own attribute quotes (index="20-12")
// are literal unescaped double-quotes sitting inside what's often a JSON
// string value — which breaks JSON.parse outright and was almost
// certainly a real, silent contributor to the "could not parse response"
// failures seen in production. Strip the tag wrapper but keep the actual
// cited sentence. Run on every response, JSON or not.
function stripCitationTags(text) {
  if (!text) return text;
  return text.replace(/<\s*cite[^>]*>/gi, "").replace(/<\s*\/\s*cite\s*>/gi, "");
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

// err.message alone (e.g. "429 status code (no body)") hasn't been enough
// to tell apart the several different real causes we've chased through this
// codebase — a genuine rate limit, an overload, a bad/expired key, and a
// content-policy refusal can all surface with a thin, generic message. The
// Anthropic SDK actually attaches much more on the error object itself:
// err.status, err.error.type/message (the real API error body), and a
// retry-after header. Logging all of it, tagged so it's easy to find in
// Render's log viewer, is the only way left to see the ACTUAL cause instead
// of continuing to guess at concurrency/token/retry settings.
function describeError(err) {
  if (!err) return "unknown error";
  const parts = [];
  if (err.status || err.statusCode) parts.push(`status=${err.status || err.statusCode}`);
  if (err.error && err.error.type) parts.push(`type=${err.error.type}`);
  if (err.error && err.error.message) parts.push(`apiMessage="${err.error.message}"`);
  if (err.headers && err.headers["retry-after"]) parts.push(`retry-after=${err.headers["retry-after"]}`);
  parts.push(`message="${err.message}"`);
  return parts.join(" ");
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
// UPDATE: the earlier *total* failure pattern (every single section
// falling back, instantly) was an invalid/stale API key — regenerating it
// fixed that specific symptom. But going to concurrency 4, then 2, both
// still showed calls randomly falling back — including calls that run
// completely alone, at a different point in the flow, not even part of a
// burst (the STAR competency questions call happens well before report
// generation starts, yet still fails sometimes). That rules out "burst of
// simultaneous calls" as the whole story — there's a genuine baseline
// flakiness on this account independent of concurrency. Since the
// dominant cost of a report is the one web-search call anyway (multiple
// search rounds inside a single request take real time no matter how many
// *other* calls run alongside it), forcing everything serial costs very
// little real speed but removes concurrency as a variable entirely, so
// retries are the only thing left to tune.
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
    // ROOT CAUSE FOUND (via the [AI-DIAGNOSTIC] logging added in the
    // previous version): claude-sonnet-5 has "adaptive thinking" turned ON
    // by default, at the "high" effort level, and thinking tokens count
    // against the SAME max_tokens budget as the actual answer. Every
    // "randomly failing" call this app has ever seen — including calls with
    // no concurrency and no web search involved at all — was really the
    // model spending its whole token budget on invisible internal reasoning
    // before it ever got to write the JSON/text we actually wanted, so it
    // hit max_tokens mid-thought (or mid-JSON-string) and came back empty
    // or truncated. This was never a rate limit, a bad key, or a
    // concurrency problem — every prior round of tuning those was chasing
    // the wrong cause. This app's calls are extraction/writing tasks, not
    // multi-step logic puzzles, so they don't need deep reasoning — turning
    // thinking off entirely fixes the reliability problem AND should
    // meaningfully speed things up (thinking tokens add real generation
    // time and were previously invisible dead weight on every single call).
    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const response = await client.messages.create({
          model: CLAUDE_MODEL,
          max_tokens: maxTokens,
          thinking: { type: "disabled" },
          messages: [{ role: "user", content: QUALITY_PREAMBLE + prompt }],
          // Capped at 3 (was 5) — each web search round-trip injects its
          // full result page back into the model's input context, which
          // counts against the account's per-minute token budget just as
          // much as generated output does. On a low-tier account, the
          // company-research call alone (4 sections, up to 5 searches)
          // could burn most of a minute's entire budget by itself before
          // it even started generating text, starving every call queued
          // behind it. Fewer, more targeted searches per call reduces that
          // footprint without materially hurting research quality.
          ...(webSearch ? { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }] } : {}),
        });

        const rawText = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
        const text = stripCitationTags(rawText);
        if (!text) {
          // This is a SILENT failure path — the call succeeded (no thrown
          // error, so nothing above ever logs or retries) but came back with
          // no usable text anyway. This can happen if the model hit
          // max_tokens while still only mid-tool-use (ran out of budget
          // before writing its final answer), or its content got filtered.
          // Given the report keeps coming back with sections missing even
          // with no errors visible, THIS path — not a thrown rate-limit
          // error — may be the real, previously-invisible culprit. Logging
          // stop_reason and block types here is the only way to tell.
          console.error(
            `[AI-DIAGNOSTIC][claudeText] attempt ${attempt} got a response with NO usable text — ` +
            `stop_reason=${response.stop_reason} blockTypes=${response.content.map((b) => b.type).join(",")} ` +
            `maxTokens=${maxTokens} webSearch=${webSearch}`
          );
          if (response.stop_reason === "max_tokens" && attempt < MAX_ATTEMPTS) {
            // Ran out of tokens before producing text — retrying with the
            // same budget will likely just repeat the failure, so bump it
            // rather than burning a retry unchanged.
            maxTokens = Math.round(maxTokens * 1.5);
            await sleep(500);
            continue;
          }
          return null;
        }

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
        console.error(`[AI-DIAGNOSTIC][claudeText] attempt ${attempt}${willRetry ? ", retrying" : ", falling back"} — ${describeError(err)}`);
        if (!willRetry) return null;
        // 2s, 4s, 8s, 16s (~30s total) — enough room for a real per-minute
        // rate limit tripped by several calls landing at once to clear,
        // without the multi-minute extremes tuned for a problem (bad key)
        // that retrying never actually fixed.
        await sleep(2000 * 2 ** (attempt - 1));
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

// Now that the model no longer burns its budget on invisible "thinking"
// (see the thinking: disabled change above), a NEW failure shape showed up
// in production logs: the model ignoring the "respond with ONLY JSON, no
// commentary" instruction and instead opening with a conversational lead-in
// — e.g. "The Glassdoor reviews suggest..." or "I have good news..." —
// before (or instead of) the actual JSON object. A stricter instruction
// alone hasn't reliably stopped this, so rather than keep tightening the
// prompt and hoping, this pulls the real JSON object/array out of whatever
// surrounding prose it's wrapped in — find the first { or [ and the
// matching last } or ], and parse just that slice. If the model wrote
// clean JSON to begin with this is a no-op (start is 0, nothing is cut).
function extractJsonSubstring(text) {
  if (!text) return text;
  const firstBrace = text.indexOf("{");
  const firstBracket = text.indexOf("[");
  let start;
  if (firstBrace === -1) start = firstBracket;
  else if (firstBracket === -1) start = firstBrace;
  else start = Math.min(firstBrace, firstBracket);
  if (start === -1) return text;
  const closeChar = text[start] === "{" ? "}" : "]";
  const end = text.lastIndexOf(closeChar);
  if (end === -1 || end <= start) return text;
  return text.slice(start, end + 1);
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
    `Your entire reply must be a single JSON value — the very first character you write must be { or [, and the ` +
    `very last character must be the matching } or ]. Do not open with a sentence like "Here's..." or "I found..." ` +
    `or any lead-in of any kind, even a short one — go straight into the JSON. ` +
    `This matters: every double-quote character and line break that appears INSIDE a string value must be properly ` +
    `escaped (\\" and \\n) so the JSON parses correctly — never include a literal, unescaped line break or ` +
    `quotation mark inside a string value. Also never include inline citation markup or tags like ` +
    `<cite index="...">...</cite> inside a string value — those contain unescaped quotes that will break the ` +
    `JSON; if you want to reference a source, just name it in plain words within the sentence.`;

  const MAX_JSON_ATTEMPTS = 2;
  for (let attempt = 1; attempt <= MAX_JSON_ATTEMPTS; attempt++) {
    const result = await claudeText(fullPrompt, { maxTokens, webSearch });
    if (!result || !result.text) return null;

    const cleaned = result.text.replace(/^```(json)?/i, "").replace(/```$/, "").trim();
    // Try the text as-is first (the common, well-behaved case), then fall
    // back to pulling just the { ... } / [ ... ] slice out of whatever
    // conversational wrapper the model added — a lead-in sentence, a
    // trailing remark, or both — before giving up on this attempt.
    const candidates = [cleaned, extractJsonSubstring(cleaned)];
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        if (webSearch) parsed.sources = result.sources;
        return parsed;
      } catch (e) { /* try the next candidate */ }
      try {
        const parsed = JSON.parse(sanitizeJsonText(candidate));
        if (webSearch) parsed.sources = result.sources;
        return parsed;
      } catch (e) { /* try the next candidate */ }
    }
    // Every candidate/repair combination above failed to parse — log what
    // actually came back. Logging just an error message ("Unexpected
    // token...") has never once told us WHAT the model actually sent, only
    // that it didn't parse — useless for telling a genuine model slip-up
    // apart from, say, the model wrapping the JSON in an explanatory
    // paragraph. A capped snippet of the actual text is what's needed to
    // see the real shape of the failure next time this fires in production.
    const willRetry = attempt < MAX_JSON_ATTEMPTS;
    console.error(
      `[AI-DIAGNOSTIC][claudeJSON] attempt ${attempt} could not parse response after trying raw + extracted + sanitized` +
      `${willRetry ? ", retrying with a fresh call" : ", falling back"}\n` +
      `  raw text (first 500 chars): ${cleaned.slice(0, 500).replace(/\n/g, "\\n")}`
    );
  }
  return null;
}

module.exports = {
  hasAnthropic, hasOpenAI, getAnthropic, getOpenAI, CLAUDE_MODEL, TRANSCRIBE_MODEL, IMAGE_MODEL,
  claudeText, claudeJSON, generateCoverImage,
};
