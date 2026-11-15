// Shows the "Sign in" link (data-account-link, hidden to start) once accounts
// are switched on, and turns it into "My account" when the visitor is signed in. Talks only to this site's own server.
(function () {
  "use strict";
  var link = document.querySelector("a[data-account-link]");
  if (!link) return;
  var base;
  try { base = new URL(link.href).origin; } catch (_) { return; }
  fetch("/api/account/me", { credentials: "same-origin", cache: "no-store" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
      if (!j) return; // accounts not switched on yet: keep the link hidden
      link.hidden = false;
      if (j.signedIn) {
        link.textContent = "My account";
        link.href = base + "/account/me.html";
      }
    })
    .catch(function () {});
})();
