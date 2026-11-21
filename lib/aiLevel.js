// How much AI someone wants Comquat to use for them (Nov 2026).
//
//   full        AI does the core job of each tool plus the extras
//   essentials  AI does the core job of each tool and nothing more (the default)
//   off         no AI at all; the tools point to the free Field Guides instead
//
// The choice is kept on the person's account (Supabase user metadata, so no
// database change is needed) and is shared by CV Rewrite, the CV Builder and
// Interview Prep, because they use the same login. People who aren't signed in
// get the default, Essentials only.

const LEVELS = ["full", "essentials", "off"];
const DEFAULT = "essentials";
const SETTINGS_URL = "https://cv.the-common-people.com/account/me.html#ai";

const clean = (l) => (LEVELS.includes(l) ? l : DEFAULT);
const levelOf = (req) => clean(req && req.user && req.user.aiLevel);

// need: "core" (the main job of a tool) or "extra" (a Full help extra)
const allows = (level, need) => (need === "extra" ? level === "full" : level !== "off");

function message(req, level, need, what, guide) {
  const guideLine = guide ? ` Or use our free guide: ${guide}` : "";
  if (level === "off") {
    return `Your AI setting is Off, so Comquat isn't using AI for you. You can switch it back on in My account at any time.${guideLine}`;
  }
  const who = req && req.user ? "Switch on Full help in My account" : "Sign in and switch on Full help in My account";
  return `${what || "This"} is a Full help extra, and your AI setting is Essentials only. ${who} if you'd like it.`;
}

// Sends a friendly refusal and returns false when the person's setting doesn't
// allow this use of AI. Returns true when it's fine to go ahead.
function gate(req, res, need, what, guide) {
  const level = levelOf(req);
  if (allows(level, need)) return true;
  res.status(403).json({
    error: message(req, level, need, what, guide),
    aiLevel: level,
    aiSettingsUrl: SETTINGS_URL,
    guideUrl: guide || null,
  });
  return false;
}

module.exports = { LEVELS, DEFAULT, SETTINGS_URL, clean, levelOf, allows, gate, message };
