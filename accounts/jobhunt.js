// Your job hunt: one card per job, carried from CV Rewrite into Interview
// Prep, with This week's two and the Nobody left wondering follow-up kit.
// Plus Your story bank: the examples someone gives once, kept to reuse.
//
// Everything runs as the signed-in person (req.sb), so Supabase's row level
// security keeps each person's rows to themselves. Until the 009 SQL has been
// run in Supabase, these routes answer "not switched on yet" and the pages
// hide the features.

const STATUSES = ["saved", "applied", "interview", "offer", "no", "withdrawn"];
const LIST_COLS = "id,title,company,status,this_week,fit,fit_note,applied_at,interview_at,heard_at,chased_at,thanked_at,notes,created_at,updated_at";
const DAY = 864e5;

const str = (v, max) => (typeof v === "string" ? v.replace(/\u0000/g, "").trim().slice(0, max) : "");
const when = (v) => { if (!v) return null; const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const missingTable = (e) => e && (e.code === "42P01" || /does not exist|schema cache/i.test(e.message || ""));

function fail(res, e, what) {
  if (missingTable(e)) return res.status(503).json({ error: "This part of your account is being switched on. Please try again soon.", setup: true });
  console.error(`[jobhunt] ${what}:`, e && e.message);
  return res.status(500).json({ error: "Something went wrong just then. Please try again." });
}

// What to do next on a card, worked out from its dates. Never nags: one
// suggestion at a time, and only once enough time has passed.
function nextStep(j, now = Date.now()) {
  const since = (v) => (v ? (now - Date.parse(v)) / DAY : null);
  if (j.status === "saved") return { kind: "apply", label: "Tailor your CV for this job" };
  if (j.status === "applied" && !j.heard_at) {
    const d = since(j.applied_at);
    if (d != null && d >= 10 && !j.chased_at) return { kind: "chase", label: "No reply yet? Send a polite chase" };
    return { kind: "wait", label: "Applied. We'll suggest a chase if you've heard nothing in 10 days" };
  }
  if (j.status === "interview") {
    const d = since(j.interview_at);
    if (d != null && d >= 0 && !j.thanked_at) return { kind: "thanks", label: "Send a thank-you note" };
    if (d != null && d < 0) return { kind: "prep", label: "Prepare for your interview" };
    return { kind: "prep", label: "Prepare for your interview" };
  }
  if (j.status === "no") return { kind: "feedback", label: "Ask for feedback" };
  if (j.status === "offer") return { kind: "done", label: "Well done. Mark your job search as found in My account" };
  return { kind: "none", label: "" };
}

// The follow-up kit: short, polite messages the person reads, edits and
// sends themselves. Plain templates, so nothing is made up.
function draft(kind, j, name) {
  const job = j.title || "the role";
  const at = j.company ? ` at ${j.company}` : "";
  const sign = `\n\nBest wishes,\n${name || "[Your name]"}`;
  if (kind === "chase") return {
    subject: `My application for ${job}${at}`,
    body: `Hello,\n\nI applied for the ${job} role${at} on ${fmt(j.applied_at)} and wanted to check it reached you. I'm still very interested and would be glad to send anything else that would help.\n\nCould you let me know where things stand when you have a moment?${sign}`
  };
  if (kind === "thanks") return {
    subject: `Thank you for today`,
    body: `Hello,\n\nThank you for taking the time to talk with me about the ${job} role${at}. I enjoyed hearing more about the team, and it's made me even keener on the job.\n\nIf there's anything else you need from me, please just ask. I look forward to hearing from you.${sign}`
  };
  if (kind === "feedback") return {
    subject: `Feedback on my application for ${job}`,
    body: `Hello,\n\nThank you for letting me know about the ${job} role${at}. I'm disappointed, but I appreciate you getting back to me.\n\nIf you have a couple of minutes, I'd be grateful for any feedback on my application or interview. Even a line or two would help me with the next one.${sign}`
  };
  return null;
}
const fmt = (v) => (v ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long" }).format(new Date(v)) : "recently");

function mountJobHunt(api, { needUser, writeLimit, requireJson }) {
  // ---- jobs ----
  api.get("/jobs", needUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const { data, error } = await req.sb.from("job_hunt").select(LIST_COLS).eq("user_id", req.user.id).order("updated_at", { ascending: false }).limit(200);
    if (error) return fail(res, error, "list");
    res.json({ jobs: data.map((j) => ({ ...j, next: nextStep(j) })) });
  });

  api.get("/jobs/:id", needUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const { data, error } = await req.sb.from("job_hunt").select("*").eq("id", req.params.id).eq("user_id", req.user.id).maybeSingle();
    if (error) return fail(res, error, "get");
    if (!data) return res.status(404).json({ error: "We couldn't find that job." });
    res.json({ job: { ...data, next: nextStep(data) } });
  });

  // Save a job (from CV Rewrite, Interview Prep or by hand). The same job
  // saved again within a fortnight updates the card instead of adding one.
  api.post("/jobs", writeLimit, requireJson, needUser, async (req, res) => {
    const b = req.body || {};
    const row = { title: str(b.title, 200), company: str(b.company, 200), advert: str(b.advert, 30000), cv_text: str(b.cvText, 40000) };
    if (b.fit && ["green", "amber", "red"].includes(b.fit)) { row.fit = b.fit; row.fit_note = str(b.fitNote, 2000) || null; }
    if (!row.title && !row.advert) return res.status(400).json({ error: "Add the job title or the advert first." });
    const since = new Date(Date.now() - 14 * DAY).toISOString();
    let q = req.sb.from("job_hunt").select("id").eq("user_id", req.user.id).eq("title", row.title).eq("company", row.company).gte("updated_at", since).limit(1);
    const { data: same, error: e1 } = await q;
    if (e1) return fail(res, e1, "find");
    const patch = Object.fromEntries(Object.entries(row).filter(([, v]) => v !== ""));
    if (same && same.length) {
      const { error } = await req.sb.from("job_hunt").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", same[0].id).eq("user_id", req.user.id);
      if (error) return fail(res, error, "update");
      return res.json({ ok: true, id: same[0].id, updated: true });
    }
    const { data, error } = await req.sb.from("job_hunt").insert({ ...row, user_id: req.user.id }).select("id").single();
    if (error) return fail(res, error, "insert");
    res.json({ ok: true, id: data.id });
  });

  api.post("/jobs/:id", writeLimit, requireJson, needUser, async (req, res) => {
    const b = req.body || {};
    const up = {};
    if (b.status !== undefined) {
      if (!STATUSES.includes(b.status)) return res.status(400).json({ error: "That isn't a stage we know." });
      up.status = b.status;
      if (b.status === "applied" && !b.appliedAt) up.applied_at = new Date().toISOString();
      if (b.status === "no" || b.status === "offer") up.heard_at = new Date().toISOString();
    }
    for (const [k, col] of [["appliedAt", "applied_at"], ["interviewAt", "interview_at"], ["heardAt", "heard_at"], ["chasedAt", "chased_at"], ["thankedAt", "thanked_at"]]) if (b[k] !== undefined) up[col] = when(b[k]);
    if (b.notes !== undefined) up.notes = str(b.notes, 4000);
    if (b.title !== undefined) up.title = str(b.title, 200);
    if (b.company !== undefined) up.company = str(b.company, 200);
    if (b.advert !== undefined) up.advert = str(b.advert, 30000);
    if (b.cvText !== undefined) up.cv_text = str(b.cvText, 40000);
    if (b.thisWeek !== undefined) {
      up.this_week = !!b.thisWeek;
      if (up.this_week) {
        const { count, error } = await req.sb.from("job_hunt").select("id", { count: "exact", head: true }).eq("user_id", req.user.id).eq("this_week", true).neq("id", req.params.id);
        if (error) return fail(res, error, "count");
        if (count >= 2) return res.status(400).json({ error: "You've already picked two for this week. Two good applications beat fifty, so swap one out first." });
      }
    }
    if (!Object.keys(up).length) return res.status(400).json({ error: "Nothing to change." });
    up.updated_at = new Date().toISOString();
    const { data, error } = await req.sb.from("job_hunt").update(up).eq("id", req.params.id).eq("user_id", req.user.id).select(LIST_COLS).maybeSingle();
    if (error) return fail(res, error, "update");
    if (!data) return res.status(404).json({ error: "We couldn't find that job." });
    res.json({ ok: true, job: { ...data, next: nextStep(data) } });
  });

  api.post("/jobs/:id/delete", writeLimit, requireJson, needUser, async (req, res) => {
    const { error } = await req.sb.from("job_hunt").delete().eq("id", req.params.id).eq("user_id", req.user.id);
    if (error) return fail(res, error, "delete");
    res.json({ ok: true });
  });

  // The follow-up kit: a message to read, change and send yourself.
  api.post("/jobs/:id/draft", writeLimit, requireJson, needUser, async (req, res) => {
    const kind = str(req.body && req.body.kind, 20);
    const { data: j, error } = await req.sb.from("job_hunt").select(LIST_COLS).eq("id", req.params.id).eq("user_id", req.user.id).maybeSingle();
    if (error) return fail(res, error, "draft");
    if (!j) return res.status(404).json({ error: "We couldn't find that job." });
    const { data: p } = await req.sb.from("profiles").select("full_name").eq("id", req.user.id).maybeSingle();
    const d = draft(kind, j, p && p.full_name);
    if (!d) return res.status(400).json({ error: "We don't have that message." });
    res.json(d);
  });

  // ---- stories ----
  const storyRow = (b) => ({ title: str(b.title, 200), situation: str(b.situation, 3000), action: str(b.action, 3000), result: str(b.result, 3000), skills: str(b.skills, 500) });
  api.get("/stories", needUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const { data, error } = await req.sb.from("stories").select("*").eq("user_id", req.user.id).order("updated_at", { ascending: false }).limit(100);
    if (error) return fail(res, error, "stories");
    res.json({ stories: data });
  });
  api.post("/stories", writeLimit, requireJson, needUser, async (req, res) => {
    const row = storyRow(req.body || {});
    if (!row.title || !(row.situation || row.action || row.result)) return res.status(400).json({ error: "Give your story a title and say what happened." });
    const src = ["cv_builder", "cv_rewrite", "interview_prep"].includes(req.body.source) ? req.body.source : "me";
    const { count } = await req.sb.from("stories").select("id", { count: "exact", head: true }).eq("user_id", req.user.id);
    if (count >= 100) return res.status(400).json({ error: "You've got 100 stories saved. Delete one to add another." });
    const { data, error } = await req.sb.from("stories").insert({ ...row, source: src, user_id: req.user.id }).select("id").single();
    if (error) return fail(res, error, "story add");
    res.json({ ok: true, id: data.id });
  });
  api.post("/stories/:id", writeLimit, requireJson, needUser, async (req, res) => {
    const { error } = await req.sb.from("stories").update({ ...storyRow(req.body || {}), updated_at: new Date().toISOString() }).eq("id", req.params.id).eq("user_id", req.user.id);
    if (error) return fail(res, error, "story update");
    res.json({ ok: true });
  });
  api.post("/stories/:id/delete", writeLimit, requireJson, needUser, async (req, res) => {
    const { error } = await req.sb.from("stories").delete().eq("id", req.params.id).eq("user_id", req.user.id);
    if (error) return fail(res, error, "story delete");
    res.json({ ok: true });
  });
}

module.exports = { mountJobHunt, nextStep, draft, STATUSES };
