/* Comquat: phone menu.
   On phones (820px and narrower) the top menu folds into a burger button and
   opens as a full-width list, instead of running off the side of the screen.
   Desktop is left exactly as it is. Works with all three Comquat headers:
     header.site > nav.nav > .links          (CV Rewrite, CV Builder)
     header.cq-head > nav  (+ .cq-book)      (My account, Master CV)
     header.site-header > nav.cq-links       (Interview Prep)
   Self-contained, no inline script, so it's fine under a strict security policy. */
(function () {
  "use strict";
  var MQ = "(max-width:820px)";
  var CSS = [
    ".cqm-burger{display:none}",
    "@media " + MQ + "{",
    ".cqm{position:relative}",
    ".cqm-burger{display:flex;flex-direction:column;justify-content:center;gap:5px;position:absolute;z-index:30;width:44px;height:44px;padding:11px 10px;",
    "background:#fff;border:1.5px solid #E9DCC8;border-radius:12px;cursor:pointer;box-sizing:border-box}",
    ".cqm-burger span{display:block;height:2.5px;width:100%;background:#17191C;border-radius:3px;transition:transform .2s ease,opacity .2s ease}",
    ".cqm-open .cqm-burger span:nth-child(1){transform:translateY(7.5px) rotate(45deg)}",
    ".cqm-open .cqm-burger span:nth-child(2){opacity:0}",
    ".cqm-open .cqm-burger span:nth-child(3){transform:translateY(-7.5px) rotate(-45deg)}",
    ".cqm-burger:focus-visible{outline:3px solid #FF8A1F;outline-offset:2px}",
    /* the menu: hidden until opened, then a list */
    ".cqm .cqm-menu{display:none!important}",
    ".cqm.cqm-open .cqm-menu{display:flex!important;flex-direction:column!important;flex-wrap:nowrap!important;align-items:stretch!important;",
    "overflow:visible!important;gap:0!important;width:100%!important;margin:4px 0 0!important;padding:0!important;grid-column:1/-1;max-height:none}",
    ".cqm-open .cqm-menu a,.cqm-open .cqm-menu button{display:block!important;width:100%!important;box-sizing:border-box;text-align:left;",
    "padding:14px 4px!important;margin:0!important;font-size:16px!important;line-height:1.3!important;white-space:normal!important;border-bottom:1px solid #E9DCC8}",
    ".cqm-open .cqm-menu a[hidden]{display:none!important}",
    ".cqm-open .cqm-menu a.active,.cqm-open .cqm-menu a[aria-current]{box-shadow:inset 4px 0 0 currentColor;padding-left:14px!important}",
    /* the coaching call pill becomes the last row, still a pill */
    ".cqm .cq-book,.cqm .cp-book{display:none!important}",
    ".cqm-open .cqm-menu .cq-book,.cqm-open .cqm-menu .cp-book{display:block!important;position:static!important;text-align:center;",
    "border-bottom:0;border-radius:999px;margin:14px 0 6px!important;padding:13px 16px!important;box-shadow:none}",
    ".cqm.cqm-open .cqm-menu a.cq-book,.cqm.cqm-open .cqm-menu a.cp-book{font-size:15px!important;line-height:1.2!important}",
    "}"
  ].join("");

  function setup() {
    var header = document.querySelector("header.site, header.cq-head, header.site-header");
    if (!header || header.getAttribute("data-cqm")) return;
    var menu = header.querySelector(".links") || header.querySelector("nav.cq-links") || header.querySelector(":scope > nav");
    var brand = header.querySelector(".cq-brand");
    if (!menu || !brand) return;
    header.setAttribute("data-cqm", "1");

    var css = document.createElement("style");
    css.id = "cqm-css";
    css.textContent = CSS;
    document.head.appendChild(css);

    // A coaching call pill that sits outside the menu joins it, at the end.
    var book = header.querySelector(":scope > .cq-book");
    if (book) menu.appendChild(book);

    if (!menu.id) menu.id = "cqm-menu";
    menu.classList.add("cqm-menu");
    var box = brand.parentElement; // the bar that holds the logo and the menu
    while (box && box !== header && !box.contains(menu)) box = box.parentElement;
    box.classList.add("cqm");

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cqm-burger";
    btn.setAttribute("aria-label", "Menu");
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-controls", menu.id);
    btn.innerHTML = "<span></span><span></span><span></span>";
    brand.insertAdjacentElement("afterend", btn);

    // Line the button up with the logo, at the right-hand edge of the bar.
    function place() {
      var cs = getComputedStyle(box);
      btn.style.right = (parseFloat(cs.paddingRight) || 16) + "px";
      btn.style.top = Math.max(4, brand.offsetTop + (brand.offsetHeight - 44) / 2) + "px";
    }
    function set(open) {
      box.classList.toggle("cqm-open", open);
      btn.setAttribute("aria-expanded", String(open));
      btn.setAttribute("aria-label", open ? "Close menu" : "Menu");
    }
    btn.addEventListener("click", function () { set(!box.classList.contains("cqm-open")); });
    menu.addEventListener("click", function (e) { if (e.target.closest && e.target.closest("a")) set(false); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && box.classList.contains("cqm-open")) { set(false); btn.focus(); } });
    var mq = window.matchMedia(MQ);
    var onChange = function () { if (!mq.matches) set(false); place(); };
    if (mq.addEventListener) mq.addEventListener("change", onChange); else if (mq.addListener) mq.addListener(onChange);
    window.addEventListener("resize", place);
    window.addEventListener("load", place);
    place();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setup);
  else setup();
})();
