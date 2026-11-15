// Comquat identity shield.
//
// Before anything is sent to an AI model, this swaps a person's identifying
// details (name, email, phone, home address and postcode, links, date of birth)
// for placeholders such as [NAME] and [EMAIL]. The AI only ever sees the
// placeholders. When the reply comes back, the real details are put back in
// before anything is shown to the person or saved.
//
// The swap is exact and reversible: every placeholder maps back to the precise
// text it replaced, so nothing is lost or reworded.
//
// Usage:
//   shield.run(() => ({ texts: [cvText], names: [name], emails: [email] }), next)
//     (wraps an Express request so every AI call inside it is shielded)
//   const { text, restore } = shield.mask(prompt)     // inside the AI doorway
//   restore(replyText) / restoreDeep(replyObject)

const { AsyncLocalStorage } = require("async_hooks");

const store = new AsyncLocalStorage();

// The note the model gets, so it keeps placeholders intact.
const MODEL_NOTE =
  "Privacy note: personal details in this request have been replaced with placeholders in square " +
  "brackets, such as [NAME], [FIRST_NAME], [EMAIL], [PHONE], [ADDRESS], [POSTCODE], [LINK_1] and [DOB]. " +
  "Wherever one of those details belongs in your answer, copy the placeholder exactly as written, " +
  "including the square brackets. Never guess, invent or ask for the real details.";

// First names that are also everyday words. We still hide the full name, but we
// don't hide these on their own, so the AI isn't left reading "[FIRST_NAME] 2021"
// for a date in May.
const COMMON_WORDS = new Set([
  "may", "june", "july", "april", "august", "march", "will", "grace", "hope", "faith", "joy", "rose",
  "mark", "bill", "pat", "sue", "dawn", "summer", "autumn", "victoria", "chase", "drew", "lane",
  "brook", "ray", "rich", "frank", "earl", "dean", "major", "king", "page", "hunter", "max", "art",
  "jack", "penny", "holly", "ivy", "iris", "amber", "crystal", "sky", "storm", "sunny", "christian",
  "england", "wales", "london", "jordan", "chelsea", "paris", "india", "kent", "sydney", "carol",
  "gene", "guy", "harry", "jean", "lily", "mercy", "noble", "pearl", "reed", "rob", "rusty", "tim",
]);

const NOT_A_NAME = /\b(curriculum|vitae|resume|résumé|cv|profile|personal|statement|summary|contact|details|experience|education|skills|address|email|phone|mobile|tel|telephone|linkedin|objective|references|page|the|and|of|for|ltd|limited|plc|college|school|university|manager|assistant|officer|director|engineer|consultant|chef|nurse|teacher|developer|executive|apprentice)\b/i;

const RE = {
  email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  url: /\b(?:https?:\/\/|www\.)[^\s<>()"']+|\b(?:linkedin\.com|github\.com|behance\.net|dribbble\.com|instagram\.com|x\.com|twitter\.com|facebook\.com|tiktok\.com|youtube\.com)\/[^\s<>()"']+/gi,
  // Phone numbers: 10 to 13 digits, allowing spaces, dots, dashes, brackets and a leading +.
  phone: /(?<![\w+(])[+(]?\d(?:[\s().-]{0,2}\d){9,13}(?!\d)/g,
  postcode: /\b(?:GIR ?0AA|[A-PR-UWYZ][A-HK-Y]?\d[A-Z\d]? ?\d[ABD-HJLNP-UW-Z]{2})\b/gi,
  dob: /\b(?:date of birth|d\.?\s?o\.?\s?b\.?|born)\s*[:\-–]?\s*([0-9A-Za-z ,./-]{6,30}?\d{2,4})\b/gi,
  dobLabelled: /\b(?:date of birth|d\.?\s?o\.?\s?b\.?)\s*[:\-–]\s*([^\n]{4,40})/gi,
  nameLabelled: /^\s*(?:full\s+)?name\s*[:\-–]\s*([^\n,|]{3,60})$/im,
};

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function digitsOnly(s) {
  return String(s).replace(/\D/g, "");
}

function cleanName(n) {
  return String(n || "").replace(/\s+/g, " ").replace(/^[\s,.;:|-]+|[\s,.;:|-]+$/g, "").trim();
}

// Does this line look like a person's name? 2 to 4 words, letters only.
function looksLikeName(line) {
  const l = cleanName(line);
  if (!l || l.length > 45 || l.length < 4) return false;
  if (/[\d@/\\:]/.test(l)) return false;
  if (NOT_A_NAME.test(l)) return false;
  const words = l.split(" ");
  if (words.length < 2 || words.length > 4) return false;
  return words.every((w) => /^[A-Z][A-Za-z'’-]*\.?$|^[A-Z][A-Z'’-]+$/.test(w));
}

// Pull a probable name from the top of a CV.
function nameFromText(text) {
  if (!text) return null;
  const labelled = RE.nameLabelled.exec(text);
  if (labelled && looksLikeName(labelled[1])) return cleanName(labelled[1]);
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 6);
  for (const raw of lines) {
    // A header line can hold the name plus contact bits: "Jane Smith | jane@x.com"
    const first = raw.split(/\s*[|•·,]\s*|\s{3,}/)[0];
    if (looksLikeName(first)) return cleanName(first);
  }
  return null;
}

function titleCase(s) {
  return s.toLowerCase().replace(/(^|[\s'’-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
}

// Build the list of { value, token } pairs for this request.
function buildIdentity(input = {}) {
  const texts = (input.texts || []).filter(Boolean).map(String);
  const all = texts.join("\n");
  const pairs = [];
  const seen = new Set();
  const counters = {};

  function add(kind, value, numbered) {
    const v = String(value || "").trim();
    if (!v || v.length < 3) return;
    const key = kind + "\u0000" + v.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    counters[kind] = (counters[kind] || 0) + 1;
    const token = numbered || counters[kind] > 1 ? `[${kind}_${counters[kind]}]` : `[${kind}]`;
    pairs.push({ kind, value: v, token });
  }

  // Names: the account or form name first, then whatever heads the CV.
  const names = [];
  for (const n of input.names || []) if (cleanName(n).split(" ").length >= 1 && cleanName(n).length >= 3) names.push(cleanName(n));
  const fromCv = nameFromText(texts[0]);
  if (fromCv) names.push(fromCv);
  const fullNames = [...new Set(names.filter((n) => n.split(" ").length >= 2).map(titleCase))];
  const parts = new Set();
  for (const n of fullNames) {
    add("NAME", n);
    const w = n.split(" ");
    if (w.length >= 3) add("NAME", `${w[0]} ${w[w.length - 1]}`);
    const bits = n.split(" ").filter((b) => b.replace(/[.'’-]/g, "").length >= 3);
    if (bits.length >= 2) {
      parts.add(JSON.stringify(["FIRST_NAME", bits[0]]));
      parts.add(JSON.stringify(["LAST_NAME", bits[bits.length - 1]]));
    }
  }
  // A single-word name given in a form (e.g. "Neil") is treated as a first name.
  for (const n of names) if (n.split(" ").length === 1) parts.add(JSON.stringify(["FIRST_NAME", titleCase(n)]));
  for (const p of parts) {
    const [kind, v] = JSON.parse(p);
    if (!COMMON_WORDS.has(v.toLowerCase())) add(kind, v);
  }

  // Emails: given ones and any in the text.
  for (const e of input.emails || []) if (e && /@/.test(e)) add("EMAIL", String(e).trim());
  for (const e of all.match(RE.email) || []) add("EMAIL", e);

  // Links: given ones and any in the text.
  for (const l of input.links || []) if (l && typeof l === "string" && l.length > 6) add("LINK", l.trim(), true);
  for (const u of all.match(RE.url) || []) add("LINK", u.replace(/[.,;:)\]]+$/, ""), true);

  // Date of birth (only when labelled as such).
  RE.dobLabelled.lastIndex = 0;
  let m;
  while ((m = RE.dobLabelled.exec(all))) add("DOB", m[1].trim());

  // Phone numbers: real-looking ones only (10 to 13 digits, not a year range).
  for (const p of all.match(RE.phone) || []) {
    const d = digitsOnly(p);
    if (d.length < 10 || d.length > 13) continue;
    if (/^(19|20)\d{2}(19|20)\d{2}/.test(d)) continue; // "2019 2021"
    add("PHONE", p.trim());
  }
  for (const p of input.phones || []) if (p) add("PHONE", String(p).trim());

  // Address: the line holding a UK postcode (if it's short enough to be an
  // address line), otherwise just the postcode.
  const lines = all.split(/\r?\n/);
  for (const line of lines) {
    RE.postcode.lastIndex = 0;
    const pc = line.match(RE.postcode);
    if (!pc) continue;
    const trimmed = line.trim();
    const withoutOthers = pairs
      .filter((p) => p.kind !== "ADDRESS")
      .reduce((s, p) => s.split(p.value).join(" "), trimmed);
    // Keep just the address part of a header line like "12 High St, Hitchin SG4 9DQ | 07700 900123"
    const segs = withoutOthers.split(/\s*[|•·]\s*|\s{3,}/).map((s) => s.trim()).filter(Boolean);
    const seg = segs.find((s) => { RE.postcode.lastIndex = 0; return RE.postcode.test(s); }) || pc[0];
    if (seg.length <= 120) add("ADDRESS", seg.replace(/^(?:address|home)\s*[:\-–]\s*/i, ""));
    for (const p of pc) add("POSTCODE", p);
  }

  // Longest first, so "Neil Copping" is swapped before "Neil".
  pairs.sort((a, b) => b.value.length - a.value.length);
  return pairs;
}

// Swap every identifying value in text for its token.
function maskWith(pairs, text) {
  if (text == null || !pairs.length) return text;
  let out = String(text);
  for (const p of pairs.filter((q) => !q.variantOf)) {
    const isWordy = p.kind === "NAME" || p.kind === "FIRST_NAME" || p.kind === "LAST_NAME";
    if (isWordy) {
      // Whole words only. Full names match in any capitalisation; single
      // first or last names only as written or in capitals.
      const re = p.kind === "NAME"
        ? new RegExp(`(?<![A-Za-z'’])${escapeRe(p.value)}(?![A-Za-z])`, "gi")
        : new RegExp(`(?<![A-Za-z'’])(?:${escapeRe(p.value)}|${escapeRe(p.value.toUpperCase())})(?![A-Za-z])`, "g");
      out = out.replace(re, (m) => tokenFor(pairs, p, m));
    } else if (p.kind === "EMAIL" || p.kind === "LINK" || p.kind === "POSTCODE") {
      out = out.replace(new RegExp(escapeRe(p.value), "gi"), (m) => tokenFor(pairs, p, m));
    } else if (p.kind === "PHONE") {
      // Match the same digits however they're spaced.
      const d = digitsOnly(p.value);
      const flex = d.split("").map(escapeRe).join("[\\s().-]{0,2}");
      out = out.replace(new RegExp(`(?<![\\w+(])[+(]?${flex}(?!\\d)`, "g"), (m) => tokenFor(pairs, p, m));
    } else {
      out = out.split(p.value).join(p.token);
    }
  }
  return out;
}

// The token for one actual match. If the text writes the value differently
// (say "JANE SMITH" for "Jane Smith", or a phone number with other spacing) it
// gets its own token, so restoring gives back exactly what was there.
// Adds the new pair to the list, so later restores know about it.
function tokenFor(pairs, p, matched) {
  if (matched === p.value) return p.token;
  const existing = pairs.find((q) => q.value === matched && q.kind === p.kind);
  if (existing) return existing.token;
  const base = p.token.slice(1, -1);
  const n = pairs.filter((q) => q.variantOf === p.token).length + 1;
  const token = `[${base}_V${n}]`;
  pairs.push({ kind: p.kind, value: matched, token, variantOf: p.token });
  return token;
}

// Put the real values back in place of the tokens.
function restoreWith(pairs, text) {
  if (text == null || !pairs.length) return text;
  let out = String(text);
  // Longest token first so [LINK_10] is handled before [LINK_1].
  const byToken = [...pairs].sort((a, b) => b.token.length - a.token.length);
  for (const p of byToken) {
    const inner = p.token.slice(1, -1);
    // Accept the model's small variations: [Name], [ NAME ], {NAME}, ⟦NAME⟧
    const re = new RegExp(`[\\[{⟦]\\s*${escapeRe(inner)}\\s*[\\]}⟧]`, "gi");
    out = out.replace(re, () => p.value);
  }
  return out;
}

function restoreDeepWith(pairs, value) {
  if (!pairs.length) return value;
  if (typeof value === "string") return restoreWith(pairs, value);
  if (Array.isArray(value)) return value.map((v) => restoreDeepWith(pairs, v));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = restoreDeepWith(pairs, v);
    return out;
  }
  return value;
}

// Run fn (usually Express's next) with an identity source for this request.
// source is a function so it's read fresh at each AI call (the CV text can be
// added part-way through a request).
function run(source, fn) {
  return store.run({ source }, fn);
}

function currentPairs() {
  const ctx = store.getStore();
  if (!ctx || typeof ctx.source !== "function") return [];
  try {
    return buildIdentity(ctx.source() || {});
  } catch (e) {
    console.error("[shield] could not build identity:", e.message);
    return [];
  }
}

// Mask one or more strings for an AI call. Returns the masked strings plus
// restore helpers bound to the same pairs.
function mask(...texts) {
  const pairs = currentPairs();
  return {
    pairs,
    active: pairs.length > 0,
    texts: texts.map((t) => maskWith(pairs, t)),
    note: pairs.length ? MODEL_NOTE : "",
    restore: (t) => restoreWith(pairs, t),
    restoreDeep: (v) => restoreDeepWith(pairs, v),
  };
}

module.exports = {
  run,
  mask,
  buildIdentity,
  maskWith,
  restoreWith,
  restoreDeepWith,
  nameFromText,
  MODEL_NOTE,
};
