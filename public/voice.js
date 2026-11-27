/* Comquat voice answers: a "Record answer" button under every answer box.
 *
 * Neil wants talking to be an option everywhere someone is asked to write an
 * answer, on every Comquat app. Some boxes already have their own button
 * (CV Rewrite step 2, the CV Builder, Beyond the Obvious); this adds one to
 * every other answer box, including ones added to the page later.
 *
 * Left alone: boxes for pasting (a CV, an advert, a writing sample), boxes
 * marked data-novoice, and boxes that already have a record button.
 * Respects the AI setting: with AI Off there's no recording (as the privacy
 * notice says). The recording goes to /api/transcribe, comes back as text and
 * is added to whatever is already typed. Nothing else changes on the page.
 */
(function () {
  "use strict";
  if (window.__comquatVoice) return;
  window.__comquatVoice = true;

  // Settings come from the script tag, so each app can point it at its own
  // transcription endpoint (CSP-friendly, no inline script needed):
  //   data-transcribe  where recordings go (default /api/transcribe)
  //   data-ticket      a short-lived pass for pages without a sign-in
  //   data-me          where to read the AI setting ("" to skip the check)
  var tag = document.currentScript || document.querySelector('script[src*="voice.js"]');
  var cfg = (tag && tag.dataset) || {};
  var URL_ = cfg.transcribe || window.COMQUAT_TRANSCRIBE_URL || "/api/transcribe";
  var TICKET = cfg.ticket || "";
  var ME = cfg.me === undefined ? "/api/account/me" : cfg.me;
  var canRecord = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  if (!canRecord) return;

  var style = document.createElement("style");
  style.textContent =
    ".cq-voice{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:6px 0 4px}" +
    ".cq-voice button{display:inline-flex;align-items:center;gap:6px;border:2px solid #F25C54;background:#fff;color:#C2362E;border-radius:999px;padding:6px 14px;font:inherit;font-weight:700;font-size:14px;line-height:1.2;cursor:pointer}" +
    ".cq-voice button:hover{background:#FFF0EF}" +
    ".cq-voice button:focus-visible{outline:3px solid #17191C;outline-offset:2px}" +
    ".cq-voice button.on{background:#F25C54;color:#fff}" +
    ".cq-voice .cq-st{font-size:13px;color:#5B5F66}";
  document.head.appendChild(style);

  // Boxes where you paste something in, rather than answer a question.
  function isPasteBox(ta) {
    if (ta.hasAttribute("data-novoice")) return true;
    if (/^(cvText|advertText|styleSample|f-sample|v-caps-text|share-text)$/.test(ta.id || "")) return true;
    if (ta.name === "advert") return true;
    var hint = [ta.getAttribute("placeholder"), ta.getAttribute("aria-label"), labelText(ta)].join(" ");
    return /\bpaste\b/i.test(hint);
  }
  function labelText(ta) {
    var l = ta.closest("label") || (ta.id && document.querySelector('label[for="' + ta.id + '"]'));
    return l ? l.textContent : "";
  }
  // Does this box already have a record button of its own? Look for one aimed
  // at it by id, or one in the same small wrapper as the box.
  var MIC = "[data-rec],[data-mic],.btn-mic,.yo-mic,.record-btn";
  function micIn(box) {
    if (!box) return false;
    if (box.querySelector(MIC)) return true;
    var btns = box.querySelectorAll("button");
    for (var j = 0; j < btns.length; j++) {
      if (!btns[j].closest(".cq-voice") && /record|microphone|\bmic\b/i.test(btns[j].textContent + " " + (btns[j].getAttribute("aria-label") || ""))) return true;
    }
    return false;
  }
  function hasOwnMic(ta) {
    // Boxes that talk about recording or the microphone already have their own.
    if (/recording|microphone/i.test((ta.getAttribute("placeholder") || "") + " " + (ta.getAttribute("aria-label") || ""))) return true;
    if (ta.id && document.querySelector('[data-mic="' + ta.id + '"],[data-target="' + ta.id + '"],[data-rec="' + ta.id + '"]')) return true;
    var p = ta.parentElement;
    if (!p || p === document.body) return false;
    if (micIn(p)) return true;
    // A box inside a <label>: the button may sit just after the label.
    if (p.tagName === "LABEL" && p.parentElement && p.parentElement !== document.body && p.parentElement.children.length <= 4) return micIn(p.parentElement);
    return false;
  }
  function visible(el) { return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length); }

  var n = 0;
  function addButton(ta) {
    ta.setAttribute("data-voice", "1");
    var wrap = document.createElement("div");
    wrap.className = "cq-voice";
    var btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "● Record answer";
    var what = labelText(ta).trim().slice(0, 80);
    if (what) btn.setAttribute("aria-label", "Record your answer: " + what);
    var st = document.createElement("span");
    st.className = "cq-st";
    st.setAttribute("role", "status");
    st.id = "cq-voice-st-" + (++n);
    wrap.appendChild(btn); wrap.appendChild(st);
    ta.insertAdjacentElement("afterend", wrap);

    var rec = null, stream = null, chunks = [];
    function reset() { btn.classList.remove("on"); btn.textContent = "● Record answer"; }
    btn.addEventListener("click", function () {
      if (rec && rec.state === "recording") { rec.stop(); return; }
      if (ta.disabled || ta.readOnly) { st.textContent = "This box isn't open yet."; return; }
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function (s) {
        stream = s; chunks = [];
        rec = new MediaRecorder(s);
        rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
        rec.onstop = function () {
          stream.getTracks().forEach(function (t) { t.stop(); });
          reset();
          var mime = (rec.mimeType || (chunks[0] && chunks[0].type) || "audio/webm").split(";")[0];
          var ext = /mp4/.test(mime) ? "mp4" : /ogg/.test(mime) ? "ogg" : /wav/.test(mime) ? "wav" : /mpeg/.test(mime) ? "mp3" : "webm";
          var fd = new FormData();
          fd.append("audio", new Blob(chunks, { type: mime }), "answer." + ext);
          if (TICKET) fd.append("ticket", TICKET);
          st.textContent = "Turning that into words…";
          // Apps that sign in with a token (not a cookie) supply their own
          // headers through window.comquatVoiceHeaders.
          Promise.resolve(window.comquatVoiceHeaders ? window.comquatVoiceHeaders() : {})
            .then(function (headers) { return fetch(URL_, { method: "POST", body: fd, credentials: "same-origin", headers: headers || {} }); })
            .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; }); })
            .then(function (res) {
              if (!res.ok || !res.j.text) { st.textContent = (res.j.error || "We couldn't hear that clearly.") + " You can type your answer instead."; return; }
              var had = ta.value.trim();
              // Set it the way a person typing would, so React-built pages
              // (the Opportunity Engine) notice the change too.
              var v = had ? had + " " + res.j.text : res.j.text;
              var setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
              if (setter && setter.set) setter.set.call(ta, v); else ta.value = v;
              ta.dispatchEvent(new Event("input", { bubbles: true }));
              ta.dispatchEvent(new Event("change", { bubbles: true }));
              st.textContent = "Done. Have a read and tweak it if you need to.";
            })
            .catch(function () { st.textContent = "We couldn't reach the server. You can type your answer instead."; });
        };
        rec.start();
        btn.classList.add("on"); btn.textContent = "■ Stop";
        st.textContent = "Recording. Press Stop when you're done.";
      }).catch(function () { st.textContent = "Your microphone is blocked. You can allow it in your browser, or type instead."; });
    });
  }

  function scan() {
    var list = document.querySelectorAll("textarea:not([data-voice])");
    for (var i = 0; i < list.length; i++) {
      var ta = list[i];
      if (!visible(ta) && !ta.closest("details")) continue; // check again when it shows
      if (isPasteBox(ta) || hasOwnMic(ta)) { ta.setAttribute("data-voice", "0"); continue; }
      addButton(ta);
    }
  }
  var t = null;
  function soon() { clearTimeout(t); t = setTimeout(scan, 150); }

  function start() {
    scan();
    new MutationObserver(soon).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden"] });
  }

  // AI setting Off means no recording. Signed-out visitors keep the button
  // (the server still checks before anything is sent).
  function go() { if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start(); }
  if (!ME) { go(); return; }
  fetch(ME, { credentials: "same-origin", cache: "no-store" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (me) {
      var level = me && (me.aiLevel || (me.company && me.company.aiLevel));
      if (level === "off") return;
      go();
    })
    .catch(go);
})();
