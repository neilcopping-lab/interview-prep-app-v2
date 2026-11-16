// The "free Comquat account" pop-up on CV Rewrite and Interview Prep.
// Shows once per visit to people who aren't signed in, only when accounts are
// switched on. "Maybe later", the cross, Escape or a click outside closes it
// for the rest of the visit. Talks only to this site's own server.
(function () {
  "use strict";
  var KEY = "cq-account-popup-closed";
  try { if (sessionStorage.getItem(KEY)) return; } catch (_) {}

  // Sign-in lives on CV Rewrite; people come back to the page they were on.
  var ACCOUNT = "https://cv.the-common-people.com/account/";
  var here = location.origin + location.pathname + location.search;
  var nextQ = "next=" + encodeURIComponent(here);

  var CSS =
    ".cqpop-back{position:fixed;inset:0;z-index:2147483000;background:rgba(23,25,28,.55);display:flex;align-items:center;justify-content:center;padding:18px;opacity:0;transition:opacity .2s ease}" +
    ".cqpop-back.cqpop-in{opacity:1}" +
    ".cqpop{position:relative;width:100%;max-width:500px;max-height:calc(100vh - 36px);overflow:auto;background:#FFF3E2;color:#17191C;border-radius:18px;border:1px solid #E9DCC8;box-shadow:0 24px 60px rgba(0,0,0,.28);padding:30px 28px 24px;font-family:'DM Sans',system-ui,-apple-system,sans-serif;font-size:16px;line-height:1.5;text-align:left;transform:translateY(8px);transition:transform .2s ease}" +
    ".cqpop-in .cqpop{transform:none}" +
    ".cqpop *{box-sizing:border-box}" +
    ".cqpop-x{position:absolute;top:10px;right:10px;width:38px;height:38px;border:0;border-radius:999px;background:transparent;color:#5B5F66;font-size:26px;line-height:1;cursor:pointer}" +
    ".cqpop-x:hover{background:#E9DCC8;color:#17191C}" +
    ".cqpop-kick{display:inline-block;font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;background:#17191C;color:#FFF3E2;border-radius:999px;padding:5px 11px;margin:0 0 12px}" +
    ".cqpop h2{font-family:'Bricolage Grotesque','DM Sans',sans-serif;font-weight:800;font-size:clamp(24px,5vw,30px);letter-spacing:-.02em;line-height:1.1;margin:0 0 8px;color:#17191C;text-transform:none}" +
    ".cqpop-lede{margin:0 0 16px;color:#5B5F66}" +
    ".cqpop ul{list-style:none;margin:0 0 16px;padding:0}" +
    ".cqpop li{background:#fff;border:1px solid #E9DCC8;border-radius:12px;padding:12px 14px;margin:0 0 8px}" +
    ".cqpop li strong{display:block;color:#1F6B45;font-size:16px}" +
    ".cqpop-soon{display:inline-block;margin-left:6px;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#B44E00;background:#fff;border:1px solid #FF8A1F;border-radius:999px;padding:1px 8px;vertical-align:2px}" +
    ".cqpop-plus{margin:0 0 18px;font-size:15px;color:#17191C}" +
    ".cqpop-acts{display:flex;flex-direction:column;gap:10px}" +
    ".cqpop-btn{display:block;text-align:center;text-decoration:none;font-weight:700;font-size:16px;border-radius:999px;padding:13px 18px;border:2px solid #1F6B45}" +
    ".cqpop-primary{background:#1F6B45;color:#fff}" +
    ".cqpop-primary:hover{background:#17553A;border-color:#17553A}" +
    ".cqpop-ghost{background:#fff;color:#1F6B45}" +
    ".cqpop-ghost:hover{background:#F4FAF6}" +
    ".cqpop-later{background:none;border:0;color:#5B5F66;font:inherit;font-size:15px;text-decoration:underline;cursor:pointer;padding:6px;margin:2px auto 0}" +
    ".cqpop a:focus-visible,.cqpop button:focus-visible{outline:3px solid #FF8A1F;outline-offset:2px}" +
    "@media (max-width:520px){.cqpop-back{padding:10px}.cqpop{padding:22px 18px 16px;font-size:15px;max-height:calc(100vh - 20px)}.cqpop-lede{margin-bottom:12px}.cqpop li{padding:9px 12px;margin-bottom:6px}.cqpop li strong{font-size:15px}.cqpop-plus{font-size:14px;margin-bottom:14px}.cqpop-btn{padding:11px 16px}.cqpop-acts{gap:8px}}" +
    "@media (prefers-reduced-motion:reduce){.cqpop-back,.cqpop{transition:none}}";

  var HTML =
    '<div class="cqpop" role="dialog" aria-modal="true" aria-labelledby="cqpop-title" aria-describedby="cqpop-lede">' +
    '<button type="button" class="cqpop-x" data-close aria-label="Close">&times;</button>' +
    '<span class="cqpop-kick">Free Comquat account</span>' +
    '<h2 id="cqpop-title">One sign-in. Three job seeker tools.</h2>' +
    '<p class="cqpop-lede" id="cqpop-lede">Sign up free and everything you make stays in one place, ready when the next job comes up.</p>' +
    "<ul>" +
    "<li><strong>CV Rewrite</strong>Your CV rewritten for the job you're going for, without inventing a thing.</li>" +
    "<li><strong>Interview Prep</strong>A report on the company, your opening pitch and the questions to get ready for.</li>" +
    '<li><strong>Master CV builder <span class="cqpop-soon">Coming soon</span></strong>Build one full CV from scratch, then tailor it for every job.</li>' +
    "</ul>" +
    '<p class="cqpop-plus">Every CV, cover letter and prep report you download is saved in My documents. Your name and contact details never go to the AI, and you can delete your account whenever you like.</p>' +
    '<div class="cqpop-acts">' +
    '<a class="cqpop-btn cqpop-primary" href="' + ACCOUNT + "?mode=signup&amp;" + nextQ.replace(/&/g, "&amp;") + '">Create my free account</a>' +
    '<a class="cqpop-btn cqpop-ghost" href="' + ACCOUNT + "?" + nextQ.replace(/&/g, "&amp;") + '">I\'ve got one: sign in</a>' +
    '<button type="button" class="cqpop-later" data-close>Maybe later, carry on without one</button>' +
    "</div></div>";

  function open() {
    if (document.querySelector(".cqpop-back")) return;
    var style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);
    var back = document.createElement("div");
    back.className = "cqpop-back";
    back.innerHTML = HTML;
    document.body.appendChild(back);
    var before = document.activeElement;
    var oldOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    requestAnimationFrame(function () { back.classList.add("cqpop-in"); });

    var focusables = back.querySelectorAll("a,button");
    (back.querySelector(".cqpop-primary") || focusables[0]).focus();

    function close() {
      try { sessionStorage.setItem(KEY, "1"); } catch (_) {}
      document.removeEventListener("keydown", onKey, true);
      document.documentElement.style.overflow = oldOverflow;
      back.remove();
      style.remove();
      if (before && before.focus) before.focus();
    }
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); close(); return; }
      if (e.key === "Tab") { // keep keyboard focus inside the pop-up
        var first = focusables[0], last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener("keydown", onKey, true);
    back.addEventListener("click", function (e) {
      if (e.target === back || e.target.closest("[data-close]")) close();
    });
    // Following a button counts as closing it for this visit too.
    back.querySelectorAll("a").forEach(function (a) {
      a.addEventListener("click", function () { try { sessionStorage.setItem(KEY, "1"); } catch (_) {} });
    });
  }

  fetch("/api/account/me", { credentials: "same-origin", cache: "no-store" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
      if (!j || j.signedIn) return; // accounts off, or already signed in
      setTimeout(open, 1200);       // let the page settle first
    })
    .catch(function () {});
})();
