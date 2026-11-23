// Two-step sign-in for Comquat Job Seekers, using Supabase's own
// authenticator-app support (TOTP).
//
// It's the person's choice, switched on in My account > Settings. Once on,
// a password or emailed link only gets them halfway (Supabase calls this
// "aal1"). Until they type the code from their app ("aal2") they're treated
// as signed out everywhere, so nothing in their account can be reached.
// People without it switched on are not affected at all.

// The assurance level is in the session's access token.
function aalOf(token) {
  try { return JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8")).aal || null; } catch (_) { return null; }
}
const verifiedTotp = (user) => ((user && user.factors) || []).filter((f) => f.factor_type === "totp" && f.status === "verified");
const hasVerified = (user) => verifiedTotp(user).length > 0;

// True when this person has two-step on but hasn't done the second step in
// this session. Only looks at the session for people who have it on.
async function pending(sb, user) {
  if (!hasVerified(user)) return false;
  try {
    const { data } = await sb.auth.getSession();
    const s = data && data.session;
    return !s || aalOf(s.access_token) !== "aal2";
  } catch (_) { return true; }
}

const cleanCode = (c) => String(c || "").replace(/\D/g, "").slice(0, 6);

async function factors(sb) {
  const { data, error } = await sb.auth.mfa.listFactors();
  if (error) throw error;
  return (data && data.all ? data.all : (data && data.totp) || []).filter((f) => f.factor_type === "totp");
}

async function verify(sb, code) {
  const c = cleanCode(code);
  if (c.length !== 6) return { error: "Type the six-digit code from your authenticator app." };
  const f = (await factors(sb)).find((x) => x.status === "verified");
  if (!f) return { error: "Two-step sign-in isn't set up on this account." };
  const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: f.id, code: c });
  if (error) return { error: "That code didn't match. Type the newest code from your authenticator app." };
  return { ok: true };
}

async function enroll(sb) {
  const all = await factors(sb);
  if (all.some((x) => x.status === "verified")) return { error: "Two-step sign-in is already on." };
  // Clear out any set-up that was started and never finished.
  for (const f of all) await sb.auth.mfa.unenroll({ factorId: f.id }).catch(() => {});
  const { data, error } = await sb.auth.mfa.enroll({ factorType: "totp", friendlyName: `Comquat ${new Date().toISOString().slice(0, 16)}`, issuer: "Comquat" });
  if (error || !data) { console.error("[mfa] enroll:", error && error.message); return { error: "Two-step sign-in isn't available just now. Please try again later." }; }
  return { factorId: data.id, qr: data.totp && data.totp.qr_code, secret: data.totp && data.totp.secret, uri: data.totp && data.totp.uri };
}

async function confirm(sb, factorId, code) {
  const c = cleanCode(code);
  if (c.length !== 6) return { error: "Type the six-digit code from your authenticator app." };
  const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: String(factorId || ""), code: c });
  if (error) return { error: "That code didn't match. Check the app shows Comquat, and type the newest code." };
  return { ok: true };
}

async function turnOff(sb, code) {
  const v = await verify(sb, code);
  if (v.error) return v;
  for (const f of await factors(sb)) {
    const { error } = await sb.auth.mfa.unenroll({ factorId: f.id });
    if (error) { console.error("[mfa] unenroll:", error.message); return { error: "We couldn't turn it off just now. Please try again." }; }
  }
  // Drop back to a normal session now the second step is gone.
  await sb.auth.refreshSession().catch(() => {});
  return { ok: true };
}

module.exports = { aalOf, hasVerified, pending, factors, verify, enroll, confirm, turnOff };
