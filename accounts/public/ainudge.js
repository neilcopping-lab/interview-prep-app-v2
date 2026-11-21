/* The one-time "want a bit more help?" note (Nov 2026).
   Shown once, after someone's first CV, and only if they're signed in and on
   Essentials only. Call window.comquatAiNudge(elementToShowItAfter). */
(function () {
  "use strict";
  var shown = false;
  window.comquatAiNudge = function (after) {
    if (shown || !after || !after.parentNode) return;
    fetch("/api/account/me", { credentials: "same-origin", cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.signedIn || d.aiLevel !== "essentials" || d.aiNudgeSeen || shown) return;
        shown = true;
        var box = document.createElement("div");
        box.className = "cq-ainudge";
        box.setAttribute("role", "status");
        box.style.cssText = "margin:16px 0;padding:16px 18px;border:2px solid #7C3AED;border-radius:12px;background:#FFFFFF;color:#17191C;font-size:15px;line-height:1.5";
        box.innerHTML =
          '<strong style="display:block;margin-bottom:4px">Want a bit more help?</strong>' +
          "You're on <strong>Essentials only</strong>, so AI does the main job and nothing more. " +
          "You can switch on <strong>Full help</strong> in My account for extras like suggested job roles and help with your pitch video. " +
          '<span style="display:block;margin-top:10px"><a href="/account/me.html#ai" style="color:#5B21B6;font-weight:bold">Choose your AI setting</a> ' +
          '&nbsp;<button type="button" style="background:none;border:0;color:#5B5F66;text-decoration:underline;cursor:pointer;font:inherit;padding:0">No thanks</button></span>';
        after.parentNode.insertBefore(box, after.nextSibling);
        box.querySelector("button").addEventListener("click", function () { box.remove(); });
        fetch("/api/account/ai-nudge-seen", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(function () {});
      })
      .catch(function () {});
  };
})();
