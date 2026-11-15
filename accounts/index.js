// Comquat accounts: one login for CV Rewrite, Interview Prep and the master CV
// builder. Drop this folder into an Express app and call mountAccounts(app).
//
// How it works
//   * Supabase (London region) holds the accounts and their data.
//   * All sign-in happens on our server. The browser never talks to Supabase
//     and never holds a Supabase key. The session lives in httpOnly cookies set
//     on .the-common-people.com, so one sign-in covers every Comquat app.
//   * Every database read and write runs as the signed-in person, so Supabase's
//     row level security means they can only ever reach their own rows.
//   * The secret key is used for one thing only: deleting an account.
//   * Nothing in this module sends anything to an AI service.
//
// Settings (Render -> Environment):
//   SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY
//   ACCOUNT_COOKIE_DOMAIN   .the-common-people.com   (leave unset for local testing)
//   ACCOUNT_BASE_URL        https://cv.the-common-people.com  (where the account pages live)
//   ACCOUNT_ALLOWED_HOSTS   the-common-people.com    (where we may send people after sign-in)
//   RESEND_API_KEY + RESEND_TOPIC_* (see resendTopics.js)

const path = require("path");
const express = require("express");
const { createServerClient, parseCookieHeader, serialize } = require("@supabase/ssr");
const { createClient } = require("@supabase/supabase-js");
const resendTopics = require("./resendTopics");

const TOPICS = ["loudspeaker", "guides", "dispatches", "apprenticeships"];

// The exact wording shown next to each box. Saved with every consent record.
const WORDING = {
  loudspeaker: "The Loudspeaker: our monthly email.",
  guides: "Field Guides and Toolkit: tell me when a new practical guide or free download goes live.",
  dispatches: "Dispatches and campaigns: new opinion and research pieces, and campaign updates.",
  apprenticeships: "Apprenticeships and early careers: news and guides for school leavers, career changers and parents.",
};

const env = (k, d = "") => (process.env[k] || d).trim();
const cfg = () => ({
  url: env("SUPABASE_URL"),
  publishable: env("SUPABASE_PUBLISHABLE_KEY") || env("SUPABASE_ANON_KEY"),
  secret: env("SUPABASE_SECRET_KEY") || env("SUPABASE_SERVICE_ROLE_KEY"),
  cookieDomain: env("ACCOUNT_COOKIE_DOMAIN"),
  baseUrl: env("ACCOUNT_BASE_URL").replace(/\/+$/, ""),
  allowedHosts: env("ACCOUNT_ALLOWED_HOSTS", "the-common-people.com")
    .split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
  secure: process.env.NODE_ENV === "production",
});

const enabled = () => {
  const c = cfg();
  return Boolean(c.url && c.publishable);
};

// ---------------------------------------------------------------------------
// Supabase client for this request, reading and writing our cookies.
// ---------------------------------------------------------------------------
function clientFor(req, res) {
  const c = cfg();
  const cookieOptions = {
    path: "/",
    sameSite: "lax",
    secure: c.secure,
    httpOnly: true,
    ...(c.cookieDomain ? { domain: c.cookieDomain } : {}),
  };
  return createServerClient(c.url, c.publishable, {
    cookieOptions,
    cookies: {
      getAll() {
        return parseCookieHeader(req.headers.cookie || "")
          .filter((x) => typeof x.value === "string");
      },
      setAll(list) {
        if (res.headersSent) return;
        for (const { name, value, options } of list) {
          res.append("Set-Cookie", serialize(name, value, { ...options, ...cookieOptions, maxAge: options && options.maxAge }));
        }
      },
    },
  });
}

function adminClient() {
  const c = cfg();
  if (!c.url || !c.secret) return null;
  return createClient(c.url, c.secret, { auth: { persistSession: false, autoRefreshToken: false } });
}

const hasSessionCookie = (req) => /(?:^|;\s*)sb-[^=]+-auth-token/.test(req.headers.cookie || "");

// ---------------------------------------------------------------------------
// Where we may send someone after signing in. Only our own sites.
// ---------------------------------------------------------------------------
function safeNext(raw, fallback = "/account/me.html") {
  const s = String(raw || "").trim();
  if (!s) return fallback;
  if (s.startsWith("/") && !s.startsWith("//") && !s.startsWith("/\\")) return s;
  try {
    const u = new URL(s);
    const host = u.hostname.toLowerCase();
    const ok = u.protocol === "https:" &&
      cfg().allowedHosts.some((h) => host === h || host.endsWith("." + h));
    return ok ? u.toString() : fallback;
  } catch (_) {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// A small in-memory rate limit for the sign-in routes.
// ---------------------------------------------------------------------------
function limiter(max, windowMs) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const k = (req.ip || "?") + "|" + req.baseUrl + req.path;
    const list = (hits.get(k) || []).filter((t) => now - t < windowMs);
    list.push(now);
    hits.set(k, list);
    if (hits.size > 5000) hits.clear();
    if (list.length > max) return res.status(429).json({ error: "Too many tries. Please wait a few minutes and try again." });
    next();
  };
}

const isEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e || "").trim());
const cleanName = (n) => String(n || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 120);

// Turn Supabase's messages into plain English without giving away whether an
// email address has an account.
function friendly(err) {
  const m = String((err && err.message) || err || "");
  if (/invalid login credentials/i.test(m)) return "That email and password don't match. Try again, or use the email link option.";
  if (/email not confirmed/i.test(m)) return "Please confirm your email first. Check your inbox for the link we sent when you signed up.";
  if (/password should be|weak password|at least/i.test(m)) return "Please choose a longer password: at least 10 characters.";
  if (/rate limit|too many/i.test(m)) return "Too many tries. Please wait a few minutes and try again.";
  if (/expired|invalid.*(token|otp|link)/i.test(m)) return "That link has expired or has already been used. Please ask for a new one.";
  return "Something went wrong there. Please try again.";
}

const requireJson = (req, res, next) => {
  if (!req.is("application/json")) return res.status(415).json({ error: "Please send JSON." });
  next();
};

// ---------------------------------------------------------------------------
// Mount everything.
//   opts.pagesPath: URL path for the account pages (default /account)
// ---------------------------------------------------------------------------
function mountAccounts(app, opts = {}) {
  const pagesPath = opts.pagesPath || "/account";
  const api = express.Router();
  const authLimit = limiter(10, 15 * 60 * 1000);
  const writeLimit = limiter(60, 15 * 60 * 1000);

  // Pages (HTML, CSS, JS). No inline scripts, so a strict security policy is fine.
  app.use(pagesPath, express.static(path.join(__dirname, "public"), { extensions: ["html"], maxAge: "10m" }));

  // Attach req.user on API and auth routes. Anonymous visitors cost nothing.
  app.use(async (req, res, next) => {
    req.user = null;
    if (!enabled() || !hasSessionCookie(req)) return next();
    if (!/^\/(api|auth)\//.test(req.path)) return next();
    try {
      req.sb = clientFor(req, res);
      const { data } = await req.sb.auth.getUser();
      if (data && data.user) req.user = { id: data.user.id, email: data.user.email };
    } catch (_) { /* treat as signed out */ }
    next();
  });

  api.use((req, res, next) => {
    if (!enabled()) return res.status(503).json({ error: "Accounts aren't switched on yet." });
    req.sb = req.sb || clientFor(req, res);
    next();
  });

  const needUser = (req, res, next) =>
    req.user ? next() : res.status(401).json({ error: "Please sign in first.", signIn: signInUrl(req) });

  function signInUrl(req) {
    const back = (req.get("referer") || "").trim();
    const base = cfg().baseUrl || "";
    return `${base}${pagesPath}/?next=${encodeURIComponent(safeNext(back, "/"))}`;
  }

  // The link in every sign-in email comes back to our /auth/confirm route,
  // carrying where the person should land afterwards. Supabase puts this into
  // the email as {{ .RedirectTo }} (see supabase/email-templates).
  function confirmUrl(req, next) {
    const base = cfg().baseUrl || `${req.protocol}://${req.get("host")}`;
    const dest = safeNext(next);
    return `${base}/auth/confirm?next=${encodeURIComponent(dest.startsWith("/") ? base + dest : dest)}`;
  }

  // ---- who am I ----------------------------------------------------------
  api.get("/me", async (req, res) => {
    if (!req.user) return res.json({ signedIn: false, accountsOn: true });
    const [{ data: profile }, { data: subs }] = await Promise.all([
      req.sb.from("profiles").select("full_name, created_at").eq("id", req.user.id).maybeSingle(),
      req.sb.from("subscriptions").select(TOPICS.join(",")).eq("user_id", req.user.id).maybeSingle(),
    ]);
    res.set("Cache-Control", "no-store");
    res.json({
      signedIn: true,
      accountsOn: true,
      email: req.user.email,
      name: (profile && profile.full_name) || "",
      memberSince: profile && profile.created_at,
      subscriptions: Object.fromEntries(TOPICS.map((t) => [t, Boolean(subs && subs[t])])),
      wording: WORDING,
    });
  });

  // ---- create an account ---------------------------------------------------
  api.post("/signup", authLimit, requireJson, async (req, res) => {
    const name = cleanName(req.body.name);
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    if (!name) return res.status(400).json({ error: "Please tell us your name." });
    if (!isEmail(email)) return res.status(400).json({ error: "Please enter a valid email address." });
    if (password.length < 10) return res.status(400).json({ error: "Please choose a password of at least 10 characters." });
    if (!req.body.agree) return res.status(400).json({ error: "Please confirm you've read how we look after your data." });
    const wanted = Object.fromEntries(TOPICS.map((t) => [t, Boolean(req.body.subscriptions && req.body.subscriptions[t])]));
    const { error } = await req.sb.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: confirmUrl(req, req.body.next),
        // Ticked boxes wait here until the email is confirmed, then get saved.
        data: { full_name: name, pending_subscriptions: wanted },
      },
    });
    if (error) return res.status(400).json({ error: friendly(error) });
    // Same answer whether or not the address already had an account.
    res.json({ ok: true, message: "Nearly there. We've sent you an email: click the link in it to confirm your address and finish setting up your account." });
  });

  // ---- sign in with password ----------------------------------------------
  api.post("/login", authLimit, requireJson, async (req, res) => {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    if (!isEmail(email) || !password) return res.status(400).json({ error: "Please enter your email and password." });
    const { error } = await req.sb.auth.signInWithPassword({ email, password });
    if (error) return res.status(400).json({ error: friendly(error) });
    res.json({ ok: true, next: safeNext(req.body.next) });
  });

  // ---- sign in with an emailed link ----------------------------------------
  api.post("/email-link", authLimit, requireJson, async (req, res) => {
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!isEmail(email)) return res.status(400).json({ error: "Please enter a valid email address." });
    await req.sb.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false, emailRedirectTo: confirmUrl(req, req.body.next) },
    });
    // Never say whether the address has an account.
    res.json({ ok: true, message: "If that email has a Comquat account, a sign-in link is on its way. It works once and expires after an hour." });
  });

  // ---- forgotten password ---------------------------------------------------
  api.post("/forgot", authLimit, requireJson, async (req, res) => {
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!isEmail(email)) return res.status(400).json({ error: "Please enter a valid email address." });
    await req.sb.auth.resetPasswordForEmail(email, { redirectTo: confirmUrl(req, `${pagesPath}/reset.html`) });
    res.json({ ok: true, message: "If that email has a Comquat account, we've sent a link to set a new password." });
  });

  // ---- set a new password (signed in, including via the reset link) --------
  api.post("/password", authLimit, requireJson, needUser, async (req, res) => {
    const password = String(req.body.password || "");
    if (password.length < 10) return res.status(400).json({ error: "Please choose a password of at least 10 characters." });
    const { error } = await req.sb.auth.updateUser({ password });
    if (error) return res.status(400).json({ error: friendly(error) });
    res.json({ ok: true, message: "Password saved." });
  });

  // ---- update name ------------------------------------------------------------
  api.post("/profile", writeLimit, requireJson, needUser, async (req, res) => {
    const name = cleanName(req.body.name);
    if (!name) return res.status(400).json({ error: "Please tell us your name." });
    const { error } = await req.sb.from("profiles").update({ full_name: name }).eq("id", req.user.id);
    if (error) return res.status(400).json({ error: friendly(error) });
    res.json({ ok: true, name });
  });

  // ---- subscriptions ----------------------------------------------------------
  async function saveSubscriptions(req, wanted, source) {
    const { data: before } = await req.sb.from("subscriptions").select(TOPICS.join(",")).eq("user_id", req.user.id).maybeSingle();
    const { error } = await req.sb.from("subscriptions").update(wanted).eq("user_id", req.user.id);
    if (error) throw error;
    const changes = TOPICS.filter((t) => Boolean(before && before[t]) !== wanted[t])
      .map((t) => ({ user_id: req.user.id, topic: t, granted: wanted[t], source, wording: WORDING[t] }));
    if (changes.length) await req.sb.from("consent_log").insert(changes);
    const { data: profile } = await req.sb.from("profiles").select("full_name").eq("id", req.user.id).maybeSingle();
    const first = ((profile && profile.full_name) || "").split(/\s+/)[0];
    resendTopics.sync(req.user.email, first, wanted).catch((e) => console.error("[accounts] resend sync:", e.message));
    return changes.length;
  }

  api.post("/subscriptions", writeLimit, requireJson, needUser, async (req, res) => {
    const wanted = Object.fromEntries(TOPICS.map((t) => [t, Boolean(req.body[t])]));
    try {
      await saveSubscriptions(req, wanted, "account");
      res.json({ ok: true, subscriptions: wanted });
    } catch (e) {
      res.status(400).json({ error: friendly(e) });
    }
  });

  // ---- download my data -------------------------------------------------------
  api.get("/export", needUser, async (req, res) => {
    const [{ data: profile }, { data: subs }, { data: consent }] = await Promise.all([
      req.sb.from("profiles").select("*").eq("id", req.user.id).maybeSingle(),
      req.sb.from("subscriptions").select("*").eq("user_id", req.user.id).maybeSingle(),
      req.sb.from("consent_log").select("topic, granted, source, wording, created_at").eq("user_id", req.user.id).order("created_at"),
    ]);
    const out = {
      exported_at: new Date().toISOString(),
      about: "Everything your Comquat account holds about you. Saved CVs and reports will appear here once that feature is live.",
      account: { email: req.user.email },
      profile, subscriptions: subs, consent_history: consent || [],
    };
    res.set("Cache-Control", "no-store");
    res.set("Content-Disposition", 'attachment; filename="my-comquat-data.json"');
    res.json(out);
  });

  // ---- delete my account --------------------------------------------------------
  api.post("/delete", authLimit, requireJson, needUser, async (req, res) => {
    if (String(req.body.confirm || "").trim().toUpperCase() !== "DELETE") {
      return res.status(400).json({ error: 'Please type DELETE to confirm.' });
    }
    const admin = adminClient();
    if (!admin) return res.status(503).json({ error: "Account deletion isn't switched on yet. Please contact us through the-common-people.com and we'll do it for you." });
    const { id, email } = req.user;
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) return res.status(500).json({ error: "We couldn't delete your account just now. Please try again." });
    resendTopics.remove(email).catch((e) => console.error("[accounts] resend remove:", e.message));
    await req.sb.auth.signOut().catch(() => {});
    res.json({ ok: true, message: "Your account and everything in it has been deleted." });
  });

  // ---- sign out --------------------------------------------------------------------
  api.post("/logout", async (req, res) => {
    await req.sb.auth.signOut().catch(() => {});
    res.json({ ok: true });
  });

  app.use("/api/account", express.json({ limit: "50kb" }), api);

  // ---- the link in every email lands here ---------------------------------------
  // Works on any device, because it uses a one-time token rather than a code
  // stored in the browser that asked for it.
  app.get("/auth/confirm", async (req, res) => {
    if (!enabled()) return res.redirect(`${pagesPath}/`);
    const sb = req.sb || clientFor(req, res);
    const type = String(req.query.type || "email");
    const allowed = ["email", "signup", "magiclink", "recovery", "invite", "email_change"];
    const tokenHash = String(req.query.token_hash || "");
    const code = String(req.query.code || "");
    let next = safeNext(req.query.next);
    let result;
    if (tokenHash && allowed.includes(type)) {
      // Our own email templates: a one-time token that works on any device.
      result = await sb.auth.verifyOtp({ type, token_hash: tokenHash });
    } else if (code) {
      // Supabase's default emails: a one-time code, which works in the same
      // browser that asked for the email.
      result = await sb.auth.exchangeCodeForSession(code);
    } else {
      return res.redirect(`${pagesPath}/?error=link`);
    }
    const { data, error } = result;
    if (error || !data || !data.user) return res.redirect(`${pagesPath}/?error=link`);
    if (type === "recovery" || /reset\.html/.test(next)) next = `${pagesPath}/reset.html`;

    // First confirmation: save the boxes they ticked on the sign-up form.
    const pending = data.user.user_metadata && data.user.user_metadata.pending_subscriptions;
    if (pending && typeof pending === "object") {
      req.user = { id: data.user.id, email: data.user.email };
      req.sb = sb;
      const wanted = Object.fromEntries(TOPICS.map((t) => [t, Boolean(pending[t])]));
      try {
        await sb.from("consent_log").insert({ user_id: data.user.id, topic: "terms", granted: true, source: "signup", wording: "Read how Comquat looks after my data (privacy notice)." });
        if (TOPICS.some((t) => wanted[t])) await saveSubscriptions(req, wanted, "signup");
        await sb.auth.updateUser({ data: { pending_subscriptions: null } });
      } catch (e) {
        console.error("[accounts] saving sign-up choices:", e.message);
      }
    }
    res.redirect(next);
  });

  return { enabled, safeNext, pagesPath };
}

module.exports = { mountAccounts, enabled, TOPICS, WORDING, _safeNext: safeNext };
