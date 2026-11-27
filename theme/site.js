// Bench Log: theme toggle, tag filter and smooth in-page links. Works without it; it only adds conveniences.
(function () {
  var root = document.documentElement;
  var btn = document.getElementById("theme-btn");
  if (btn) btn.addEventListener("click", function () {
    var dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("bench-theme", root.dataset.theme); } catch (e) {}
  });

  var filters = document.getElementById("filters"), list = document.getElementById("post-list");
  if (filters && list) {
    var active = null;
    filters.addEventListener("click", function (e) {
      var b = e.target.closest("button.tag"); if (!b) return;
      active = active === b.dataset.tag ? null : b.dataset.tag;
      filters.querySelectorAll("button.tag").forEach(function (x) { x.setAttribute("aria-pressed", String(x.dataset.tag === active)); });
      var shown = 0;
      list.querySelectorAll(".row").forEach(function (r) {
        var ok = !active || (" " + r.dataset.tags + " ").indexOf(" " + active + " ") >= 0;
        r.hidden = !ok; if (ok) shown++;
      });
      var none = document.getElementById("no-match"); if (none) none.hidden = shown > 0;
    });
  }

  /* ---------- click tracking (GoatCounter events) ----------
     Only runs when the GoatCounter script is on the page (the public site with a code set).
     Each click is counted as an event named click/<where>/<target>, for example
     click/sidebar/posts/nocto-part-1/ or click/post-body/out:docs.zephyrproject.org/... */
  var REGIONS = [
    [".featured", "featured"], ["#post-list", "post-list"], [".series", "series"], [".pager", "pager"],
    [".footnotes", "footnotes"], [".outline", "outline"], [".card", "project-card"], ["footer.site", "footer"],
    [".sidebar", "sidebar"], [".prose", "post-body"],
  ];
  function track(name, title) {
    var gc = window.goatcounter;
    if (!gc || typeof gc.count !== "function") return;
    try { gc.count({ path: name.slice(0, 500), title: (title || "").slice(0, 120), event: true }); } catch (err) {}
  }
  function region(el) {
    for (var i = 0; i < REGIONS.length; i++) if (el.closest(REGIONS[i][0])) return REGIONS[i][1];
    return "page";
  }
  document.addEventListener("click", function (e) {
    var a = e.target.closest("a[href]"); if (!a) return;
    var href = a.getAttribute("href"), target;
    if (href.charAt(0) === "#") target = href;
    else {
      var u; try { u = new URL(a.href); } catch (err) { return; }
      if (!/^https?:$/.test(u.protocol)) return;
      target = u.origin === location.origin ? u.pathname + u.hash : "out:" + u.host + u.pathname;
    }
    var label = (a.querySelector("h1, h2, h3") || a).textContent.replace(/\s+/g, " ").trim();
    track("click/" + region(a) + "/" + (target.replace(/^\//, "") || "home"), label);
  }, true);
  if (filters) filters.addEventListener("click", function (e) {
    var b = e.target.closest("button.tag");
    if (b && b.getAttribute("aria-pressed") === "true") track("tag/" + b.dataset.tag, "Filtered posts by #" + b.dataset.tag);
  });
  if (btn) btn.addEventListener("click", function () { track("theme/" + root.dataset.theme, "Switched theme"); });

  document.addEventListener("click", function (e) {
    var a = e.target.closest('a[href^="#"]'); if (!a) return;
    var el = document.getElementById(a.getAttribute("href").slice(1)); if (!el) return;
    e.preventDefault();
    el.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    history.replaceState(null, "", a.getAttribute("href"));
  });
})();
