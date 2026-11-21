// Easy read mode for every Comquat tool: bigger, plainer text and a button that
// reads the page (or whatever you've selected) out loud. One switch, remembered
// on this device. Nothing is sent anywhere: reading aloud uses the browser.
(function () {
  "use strict";
  var KEY = "cqEasyRead";
  var css = "html.cq-easy body{font-size:19px !important;line-height:1.75 !important;letter-spacing:.015em;word-spacing:.08em}" +
    "html.cq-easy body,html.cq-easy input,html.cq-easy textarea,html.cq-easy select,html.cq-easy button{font-family:Verdana,Arial,sans-serif !important}" +
    "html.cq-easy p,html.cq-easy li,html.cq-easy label{max-width:68ch}" +
    "html.cq-easy .small,html.cq-easy small{font-size:17px !important}" +
    ".cq-er{position:fixed;left:14px;bottom:14px;z-index:9999;display:flex;gap:8px;flex-wrap:wrap}" +
    ".cq-er button{font:700 15px Arial,sans-serif;border:2px solid #17191C;background:#fff;color:#17191C;border-radius:999px;padding:9px 14px;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.15)}" +
    ".cq-er button[aria-pressed=true]{background:#17191C;color:#fff}" +
    "@media print{.cq-er{display:none}}";
  function store(v) { try { if (v) localStorage.setItem(KEY, "1"); else localStorage.removeItem(KEY); } catch (e) {} }
  function stored() { try { return localStorage.getItem(KEY) === "1"; } catch (e) { return false; } }

  function start() {
    var st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
    var box = document.createElement("div"); box.className = "cq-er";
    var toggle = document.createElement("button"); toggle.type = "button"; toggle.textContent = "Aa Easy read";
    var speak = document.createElement("button"); speak.type = "button"; speak.textContent = "Read aloud";
    var canSpeak = "speechSynthesis" in window;
    box.appendChild(toggle); if (canSpeak) box.appendChild(speak);
    document.body.appendChild(box);

    function set(on) {
      document.documentElement.classList.toggle("cq-easy", on);
      toggle.setAttribute("aria-pressed", on ? "true" : "false");
      speak.style.display = on ? "" : "none";
      store(on);
      if (!on && canSpeak) { window.speechSynthesis.cancel(); speak.textContent = "Read aloud"; }
    }
    toggle.onclick = function () { set(!document.documentElement.classList.contains("cq-easy")); };

    speak.onclick = function () {
      var s = window.speechSynthesis;
      if (s.speaking) { s.cancel(); speak.textContent = "Read aloud"; return; }
      var sel = String(window.getSelection ? window.getSelection() : "").trim();
      var root = document.querySelector(".panel.active, .step.on, main") || document.body;
      var text = sel || (root.innerText || "").replace(/\s+/g, " ").trim();
      if (!text) return;
      var u = new SpeechSynthesisUtterance(text.slice(0, 6000));
      u.lang = "en-GB"; u.rate = 0.95;
      var gb = s.getVoices().filter(function (v) { return /en-GB/i.test(v.lang); })[0]; if (gb) u.voice = gb;
      u.onend = function () { speak.textContent = "Read aloud"; };
      s.speak(u); speak.textContent = "Stop reading";
    };
    speak.title = "Reads the page, or just the words you've selected";
    set(stored());
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
