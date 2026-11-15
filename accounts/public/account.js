// Comquat account pages. Talks only to our own server (/api/account/...).
(function () {
  "use strict";
  var page = document.body.getAttribute("data-page");
  var msg = document.getElementById("msg");
  var params = new URLSearchParams(location.search);
  var next = params.get("next") || "";

  function say(text, ok) {
    if (!msg) return;
    msg.textContent = text || "";
    msg.className = "msg " + (ok ? "ok" : "err");
    if (text) msg.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function post(url, body) {
    return fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || "Something went wrong there. Please try again.");
        return j;
      });
    });
  }

  function busy(form, on) {
    var b = form.querySelector('button[type="submit"]');
    if (b) b.disabled = on;
  }

  function onSubmit(id, handler) {
    var form = document.getElementById(id);
    if (!form) return;
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      say("");
      busy(form, true);
      new Promise(function (res) { res(handler(form, new FormData(form))); })
        .catch(function (err) { say(err.message, false); })
        .then(function () { busy(form, false); });
    });
  }

  // ---------------------------------------------------------------- sign in
  if (page === "signin") {
    var tabs = { signin: document.getElementById("tab-signin"), signup: document.getElementById("tab-signup") };
    var panels = {
      signin: document.getElementById("panel-signin"),
      signup: document.getElementById("panel-signup"),
      forgot: document.getElementById("panel-forgot"),
    };
    var show = function (which) {
      Object.keys(panels).forEach(function (k) { panels[k].classList.toggle("hidden", k !== which); });
      tabs.signin.setAttribute("aria-selected", String(which !== "signup"));
      tabs.signup.setAttribute("aria-selected", String(which === "signup"));
      document.getElementById("title").textContent = which === "signup" ? "Create your Comquat account" : "Your Comquat account";
      say("");
    };
    tabs.signin.addEventListener("click", function () { show("signin"); });
    tabs.signup.addEventListener("click", function () { show("signup"); });
    document.getElementById("show-forgot").addEventListener("click", function () { show("forgot"); });
    document.getElementById("back-signin").addEventListener("click", function () { show("signin"); });
    if (params.get("mode") === "signup") show("signup");
    if (params.get("error") === "link") say("That link has expired or has already been used. Please ask for a new one below.", false);

    // Already signed in? Go straight on.
    fetch("/api/account/me", { credentials: "same-origin" }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.signedIn) location.replace(next || "/account/me.html");
      if (j && j.accountsOn === false) say("Accounts are being switched on. Please check back very soon.", false);
    }).catch(function () {});

    onSubmit("form-login", function (form, fd) {
      return post("/api/account/login", { email: fd.get("email"), password: fd.get("password"), next: next })
        .then(function (j) { location.assign(j.next || "/account/me.html"); });
    });
    onSubmit("form-link", function (form, fd) {
      return post("/api/account/email-link", { email: fd.get("email"), next: next })
        .then(function (j) { say(j.message, true); form.reset(); });
    });
    onSubmit("form-forgot", function (form, fd) {
      return post("/api/account/forgot", { email: fd.get("email") })
        .then(function (j) { say(j.message, true); form.reset(); });
    });
    onSubmit("form-signup", function (form, fd) {
      var subs = {};
      ["loudspeaker", "guides", "dispatches", "apprenticeships"].forEach(function (t) { subs[t] = fd.get(t) === "on"; });
      return post("/api/account/signup", {
        name: fd.get("name"), email: fd.get("email"), password: fd.get("password"),
        agree: fd.get("agree") === "on", subscriptions: subs, next: next,
      }).then(function (j) {
        form.reset();
        // Swap the form for the message, so it's obvious the email has gone.
        panels.signup.classList.add("hidden");
        document.getElementById("title").textContent = "Check your email";
        say(j.message, true);
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
    });
  }

  // ---------------------------------------------------------------- my account
  if (page === "me") {
    var subsForm = document.getElementById("form-subs");
    fetch("/api/account/me", { credentials: "same-origin", cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.signedIn) { location.replace("/account/?next=" + encodeURIComponent("/account/me.html")); return; }
        var first = (j.name || "").split(/\s+/)[0];
        document.getElementById("hello").textContent = first ? "Hello, " + first : "Your account";
        document.getElementById("email").textContent = j.email;
        document.getElementById("since").textContent = j.memberSince
          ? new Date(j.memberSince).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : "";
        document.querySelector('#form-name input[name="name"]').value = j.name || "";
        Object.keys(j.subscriptions || {}).forEach(function (t) {
          var box = subsForm.querySelector('input[name="' + t + '"]');
          if (box) box.checked = Boolean(j.subscriptions[t]);
        });
      })
      .catch(function () { say("We couldn't load your account just now. Please refresh the page.", false); });

    onSubmit("form-name", function (form, fd) {
      return post("/api/account/profile", { name: fd.get("name") }).then(function (j) {
        var first = (j.name || "").split(/\s+/)[0];
        document.getElementById("hello").textContent = first ? "Hello, " + first : "Your account";
        say("Name saved.", true);
      });
    });
    onSubmit("form-subs", function (form, fd) {
      var body = {};
      ["loudspeaker", "guides", "dispatches", "apprenticeships"].forEach(function (t) { body[t] = fd.get(t) === "on"; });
      return post("/api/account/subscriptions", body).then(function () { say("Your choices are saved.", true); });
    });
    onSubmit("form-password", function (form, fd) {
      return post("/api/account/password", { password: fd.get("password") }).then(function (j) { form.reset(); say(j.message, true); });
    });
    document.getElementById("show-delete").addEventListener("click", function () {
      document.getElementById("form-delete").classList.remove("hidden");
      document.querySelector('#form-delete input[name="confirm"]').focus();
    });
    onSubmit("form-delete", function (form, fd) {
      return post("/api/account/delete", { confirm: fd.get("confirm") }).then(function (j) {
        document.querySelector("main").innerHTML =
          '<h1>Account deleted</h1><p class="lede"></p><p><a class="btn btn-primary" href="https://the-common-people.com/">Back to The Com\'mon People</a></p>';
        document.querySelector("main .lede").textContent = j.message;
      });
    });
    document.getElementById("signout").addEventListener("click", function () {
      post("/api/account/logout").then(function () { location.assign("/account/"); });
    });
  }

  // ---------------------------------------------------------------- new password
  if (page === "reset") {
    onSubmit("form-reset", function (form, fd) {
      if (fd.get("password") !== fd.get("password2")) throw new Error("Those two passwords don't match. Please try again.");
      return post("/api/account/password", { password: fd.get("password") }).then(function () {
        say("Password saved. Taking you to your account…", true);
        setTimeout(function () { location.assign("/account/me.html"); }, 1200);
      });
    });
  }
})();
