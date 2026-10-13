/* Partner Collection pages: gallery thumbnails, filters, photo viewer, copy buttons.
   Generated pages; see tools/collection/README.md. */
(function () {
  "use strict";

  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  /* ---------------------------------------------------------- gallery */

  function show(sec, i) {
    var thumbs = $$(".pc-thumb", sec);
    var t = thumbs[i];
    if (!t) return;
    var stage = sec.querySelector(".pc-stage");
    var img = stage.querySelector("img");
    stage.dataset.index = i;
    thumbs.forEach(function (x, j) {
      x.classList.toggle("is-on", j === i);
      if (j === i) x.setAttribute("aria-current", "true"); else x.removeAttribute("aria-current");
    });
    if (img.getAttribute("src") === t.dataset.src) return;
    stage.classList.add("is-loading");
    var pre = new Image();
    pre.onload = pre.onerror = function () {
      stage.classList.toggle("is-room", t.dataset.kind === "room");
      img.src = t.dataset.src;
      img.width = +t.dataset.w;
      img.height = +t.dataset.h;
      img.alt = t.dataset.alt;
      stage.classList.remove("is-loading");
    };
    pre.src = t.dataset.src;
  }

  $$(".pc-model").forEach(function (sec) {
    $$(".pc-thumb", sec).forEach(function (t, i) {
      t.addEventListener("click", function () { show(sec, i); });
    });
    var stage = sec.querySelector(".pc-stage");
    if (stage) stage.addEventListener("click", function () { openViewer(sec, +stage.dataset.index || 0); });
  });

  /* ---------------------------------------------------------- filters */

  var chips = $$(".pc-chip");
  var empty = document.querySelector(".pc-empty");

  function hasTag(el, f) { return f === "all" || (el.dataset.tags || "").split(" ").indexOf(f) >= 0; }

  function applyFilter(f) {
    chips.forEach(function (c) {
      var on = c.dataset.filter === f;
      c.classList.toggle("is-on", on);
      c.setAttribute("aria-pressed", on ? "true" : "false");
    });
    var shown = 0;
    $$(".pc-tile").forEach(function (t) { var ok = hasTag(t, f); t.hidden = !ok; if (ok) shown++; });
    var k = 0;
    $$(".pc-model").forEach(function (s) {
      var ok = hasTag(s, f);
      s.hidden = !ok;
      if (ok) { s.classList.toggle("is-flip", k % 2 === 1); k++; }
    });
    $$("[data-break]").forEach(function (b) { b.hidden = f !== "all"; });
    if (empty) empty.hidden = shown > 0;
  }

  chips.forEach(function (c) {
    c.addEventListener("click", function () { applyFilter(c.dataset.filter); });
  });

  /* In-page links. The site uses <base href="/">, so links carry the page
     name; scroll here instead of reloading. */
  $$('.pc-tile a[href*="#"]').forEach(function (a) {
    a.addEventListener("click", function (e) {
      var id = a.getAttribute("href").split("#")[1];
      var target = id && document.getElementById(id);
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      if (history.replaceState) history.replaceState(null, "", "#" + id);
    });
  });

  /* ---------------------------------------------------------- photo viewer */

  var lb = document.querySelector(".pc-lb");
  var lbImg = lb && lb.querySelector(".pc-lb-img");
  var lbCap = lb && lb.querySelector(".pc-lb-cap");
  var cur = { sec: null, i: 0 };
  var lastFocus = null;

  function go(i) {
    var thumbs = $$(".pc-thumb", cur.sec);
    var n = thumbs.length;
    if (!n) return;
    i = ((i % n) + n) % n;
    cur.i = i;
    var t = thumbs[i];
    lbImg.src = t.dataset.src;
    lbImg.alt = t.dataset.alt;
    lbCap.textContent = cur.sec.dataset.label + " · " + cur.sec.dataset.name + " · " + (i + 1) + " / " + n;
    var multi = n > 1;
    lb.querySelector(".pc-lb-prev").hidden = !multi;
    lb.querySelector(".pc-lb-next").hidden = !multi;
  }

  function openViewer(sec, i) {
    if (!lb) return;
    cur.sec = sec;
    lastFocus = document.activeElement;
    lb.hidden = false;
    document.body.classList.add("pc-lb-open");
    go(i);
    lb.querySelector(".pc-lb-close").focus();
  }

  function closeViewer() {
    lb.hidden = true;
    document.body.classList.remove("pc-lb-open");
    if (cur.sec) show(cur.sec, cur.i);
    lbImg.src = "data:,";
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  if (lb) {
    lb.querySelector(".pc-lb-close").addEventListener("click", closeViewer);
    lb.querySelector(".pc-lb-prev").addEventListener("click", function () { go(cur.i - 1); });
    lb.querySelector(".pc-lb-next").addEventListener("click", function () { go(cur.i + 1); });
    lb.addEventListener("click", function (e) { if (e.target === lb) closeViewer(); });
    document.addEventListener("keydown", function (e) {
      if (lb.hidden) return;
      if (e.key === "Escape") { e.preventDefault(); closeViewer(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); go(cur.i - 1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); go(cur.i + 1); }
      else if (e.key === "Tab") {
        var f = $$("button:not([hidden])", lb);
        var at = f.indexOf(document.activeElement);
        e.preventDefault();
        f[(at + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
      }
    });
    var x0 = null;
    lb.addEventListener("touchstart", function (e) { x0 = e.touches[0].clientX; }, { passive: true });
    lb.addEventListener("touchend", function (e) {
      if (x0 === null) return;
      var dx = e.changedTouches[0].clientX - x0;
      x0 = null;
      if (Math.abs(dx) > 40) go(cur.i + (dx < 0 ? 1 : -1));
    });
  }

  /* ---------------------------------------------------------- copy buttons (posts page) */

  function copy(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { if (document.execCommand("copy")) resolve(); else reject(); } catch (err) { reject(err); }
      document.body.removeChild(ta);
    });
  }

  $$("[data-copy], [data-copy-text]").forEach(function (b) {
    var label = b.textContent;
    b.addEventListener("click", function () {
      var src = b.dataset.copy ? document.querySelector(b.dataset.copy) : null;
      var text = b.dataset.copyText || (src ? src.textContent : "");
      copy(text).then(function () {
        b.textContent = "Copied";
        b.classList.add("is-done");
      }, function () {
        b.textContent = "Copy failed";
      }).then(function () {
        setTimeout(function () { b.textContent = label; b.classList.remove("is-done"); }, 1600);
      });
    });
  });
})();
