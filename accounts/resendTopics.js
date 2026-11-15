// Keeps Resend in step with the subscription boxes ticked in a Comquat account.
// Supabase is the source of truth. Resend only gets told who wants which emails.
// If Resend is not set up, or a call fails, the account still saves: this is
// best effort and never blocks the person.
//
// Topic ids come from Resend (Audience -> Topics). Set them in Render:
//   RESEND_TOPIC_LOUDSPEAKER, RESEND_TOPIC_GUIDES,
//   RESEND_TOPIC_DISPATCHES, RESEND_TOPIC_APPRENTICESHIPS

const API = "https://api.resend.com";

const TOPIC_ENV = {
  loudspeaker: "RESEND_TOPIC_LOUDSPEAKER",
  guides: "RESEND_TOPIC_GUIDES",
  dispatches: "RESEND_TOPIC_DISPATCHES",
  apprenticeships: "RESEND_TOPIC_APPRENTICESHIPS",
};

function key() {
  return process.env.RESEND_API_KEY || "";
}

async function call(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok && res.status !== 404 && res.status !== 409 && res.status !== 422) {
    const text = await res.text().catch(() => "");
    throw new Error(`Resend ${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  }
  return res;
}

// subs: { loudspeaker: bool, guides: bool, dispatches: bool, apprenticeships: bool }
async function sync(email, firstName, subs) {
  if (!key()) return { skipped: "no RESEND_API_KEY" };
  const topics = Object.entries(TOPIC_ENV)
    .filter(([, env]) => process.env[env])
    .map(([name, env]) => ({ id: process.env[env], subscription: subs[name] ? "opt_in" : "opt_out" }));
  if (!topics.length) return { skipped: "no topic ids set" };
  const addr = encodeURIComponent(String(email).toLowerCase());
  // Make sure the contact exists (a duplicate is fine), then set each topic.
  // We never touch "unsubscribed": if someone has unsubscribed from everything
  // via an email link, that choice stands.
  await call("POST", "/contacts", { email: String(email).toLowerCase(), first_name: firstName || undefined });
  await call("PATCH", `/contacts/${addr}/topics`, topics);
  return { ok: true, topics: topics.length };
}

async function remove(email) {
  if (!key()) return { skipped: "no RESEND_API_KEY" };
  await call("DELETE", `/contacts/${encodeURIComponent(String(email).toLowerCase())}`);
  return { ok: true };
}

module.exports = { sync, remove, TOPIC_ENV };
