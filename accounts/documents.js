// Saved documents: every CV, cover letter and interview prep report a signed-in
// person downloads is kept in their account, so they can download it again or
// delete it.
//
//   * Files go into a private Supabase storage bucket called "documents", in a
//     folder named after the person's account id. There are no public links.
//   * Saving, listing, downloading and deleting all run as the signed-in
//     person, so Supabase's own rules stop anyone reaching anyone else's files.
//   * The secret key is only used when a whole account is deleted, to clear
//     out that account's folder first.

const crypto = require("crypto");

const BUCKET = "documents";
const KINDS = { cv: "CV", cover: "Cover letter", prep: "Interview prep report" };
const MIME_OK = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/pdf",
  "text/plain",
]);
const MAX_BYTES = 25 * 1024 * 1024;

const clip = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const safeFileName = (n) => clip(n, 150).replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, "_") || "document";

// A stable fingerprint for "the same file", so a second click on Download
// doesn't save a second copy. Built from what the file was made from, not the
// file bytes (Word files carry a fresh timestamp each time they're built).
function sourceKey(kind, ...parts) {
  const h = crypto.createHash("sha256");
  h.update(kind);
  for (const p of parts) h.update("\u0000" + (typeof p === "string" ? p : JSON.stringify(p == null ? null : p)));
  return `${kind}:${h.digest("hex").slice(0, 40)}`;
}

function withTimeout(promise, ms) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error("timed out")), ms); }),
  ]).finally(() => clearTimeout(t));
}

// Save a file to the signed-in person's account. Never throws: a failed save
// must never stop someone getting their download. Returns
// { saved: true } | { saved: false, reason }.
async function save(req, doc) {
  try {
    if (!req.user || !req.sb) return { saved: false, reason: "signed-out" };
    const kind = KINDS[doc.kind] ? doc.kind : null;
    if (!kind) return { saved: false, reason: "bad-kind" };
    const data = Buffer.isBuffer(doc.data) ? doc.data : Buffer.from(doc.data || "");
    const mime = MIME_OK.has(doc.mimeType) ? doc.mimeType : null;
    if (!mime || !data.length || data.length > MAX_BYTES) return { saved: false, reason: "bad-file" };
    const key = clip(doc.sourceKey, 120);

    return await withTimeout((async () => {
      if (key) {
        const { data: existing } = await req.sb.from("documents").select("id").eq("user_id", req.user.id).eq("source_key", key);
        if (existing && existing.length) return { saved: true, already: true };
      }
      const fileName = safeFileName(doc.fileName);
      const storagePath = `${req.user.id}/${crypto.randomUUID()}-${fileName}`;
      const up = await req.sb.storage.from(BUCKET).upload(storagePath, data, { contentType: mime, upsert: false });
      if (up.error) throw new Error(up.error.message);
      const { error } = await req.sb.from("documents").insert({
        user_id: req.user.id,
        kind,
        title: clip(doc.title || KINDS[kind], 200),
        job_title: clip(doc.jobTitle, 200),
        company: clip(doc.company, 200),
        file_name: fileName,
        mime_type: mime,
        size_bytes: data.length,
        storage_path: storagePath,
        source_key: key,
      });
      if (error) {
        // Most likely a second click that raced the first: tidy up the extra file.
        await req.sb.storage.from(BUCKET).remove([storagePath]).catch(() => {});
        if (/duplicate|unique/i.test(error.message || "")) return { saved: true, already: true };
        throw new Error(error.message);
      }
      return { saved: true };
    })(), 8000);
  } catch (e) {
    console.error("[documents] save failed:", e.message);
    return { saved: false, reason: "error" };
  }
}

async function list(req) {
  const { data, error } = await req.sb
    .from("documents")
    .select("id, kind, title, job_title, company, file_name, mime_type, size_bytes, created_at")
    .eq("user_id", req.user.id)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  // Only these fields ever go to the browser (never the storage path).
  return (data || []).map((d) => ({
    id: d.id, kind: d.kind, kind_label: KINDS[d.kind] || "Document", title: d.title,
    job_title: d.job_title, company: d.company, file_name: d.file_name,
    mime_type: d.mime_type, size_bytes: d.size_bytes, created_at: d.created_at,
  }));
}

async function getOne(req, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ""))) return null;
  const { data } = await req.sb.from("documents").select("*").eq("user_id", req.user.id).eq("id", id);
  return data && data[0] ? data[0] : null;
}

async function fileOf(req, row) {
  const { data, error } = await req.sb.storage.from(BUCKET).download(row.storage_path);
  if (error || !data) throw new Error((error && error.message) || "missing");
  return Buffer.from(await data.arrayBuffer());
}

async function removeOne(req, row) {
  const { error: e1 } = await req.sb.storage.from(BUCKET).remove([row.storage_path]);
  if (e1) throw new Error(e1.message);
  const { error: e2 } = await req.sb.from("documents").delete().eq("user_id", req.user.id).eq("id", row.id);
  if (e2) throw new Error(e2.message);
}

// Used when a whole account is deleted: clear out the person's folder with the
// secret key (their rows go with the account automatically).
async function removeAllFor(admin, userId) {
  const bucket = admin.storage.from(BUCKET);
  for (let round = 0; round < 50; round++) {
    const { data, error } = await bucket.list(userId, { limit: 1000 });
    if (error) {
      if (/not.?found/i.test(error.message || "")) return; // bucket not set up yet: nothing stored
      throw new Error(error.message);
    }
    const paths = (data || []).filter((o) => o && o.name).map((o) => `${userId}/${o.name}`);
    if (!paths.length) return;
    const { error: e2 } = await bucket.remove(paths);
    if (e2) throw new Error(e2.message);
  }
}

module.exports = { save, list, getOne, fileOf, removeOne, removeAllFor, sourceKey, KINDS };
