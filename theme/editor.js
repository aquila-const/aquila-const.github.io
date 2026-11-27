// Bench Log local editor. Talks to scripts/dev.mjs; never shipped to the live site.
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const slugify = (s) => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  const words = (md) => (String(md || "").replace(/```[\s\S]*?```/g, " ").match(/[A-Za-z0-9'’-]+/g) || []).length;
  const readMins = (md) => Math.max(1, Math.round(words(md) / 220));
  const v = $("v-editor");

  async function call(method, url, body, raw) {
    const opts = { method, headers: { "X-Bench-Editor": "1" } };
    if (raw) { opts.body = raw; opts.headers["Content-Type"] = raw.type || "application/octet-stream"; }
    else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers["Content-Type"] = "application/json"; }
    let r;
    try { r = await fetch(url, opts); } catch { throw new Error("The editor server isn’t running. Start it with npm run dev."); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Request failed (" + r.status + ").");
    return data;
  }

  const S = { state: null, slug: null, edit: null, dirty: false, saving: null, mode: "split", busy: false };
  try { S.mode = localStorage.getItem("bench-mode") || "split"; } catch {}
  let saveT, prevT;

  /* ---------- helpers ---------- */
  const toLocalInput = (iso) => { if (!iso) return ""; const d = new Date(iso); if (isNaN(d)) return ""; const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
  const fmtWhen = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const isFuture = (iso) => !!iso && Date.parse(iso) > Date.now();
  function toast(msg) {
    let t = $("toast"); if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; t.setAttribute("role", "status"); document.body.append(t); }
    t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3600);
  }
  async function refreshSidebar() {
    try {
      const html = await (await fetch("/editor/")).text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      document.querySelector(".sidebar").innerHTML = doc.querySelector(".sidebar").innerHTML;
      markCurrent();
      const tb = document.getElementById("theme-btn");
      if (tb) tb.onclick = () => { const r = document.documentElement; const dark = r.dataset.theme ? r.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches; r.dataset.theme = dark ? "light" : "dark"; try { localStorage.setItem("bench-theme", r.dataset.theme); } catch {} };
    } catch {}
  }
  function markCurrent() {
    document.querySelectorAll(".sidebar a.nav-item").forEach((a) => {
      const h = a.getAttribute("href");
      const key = P.slug ? "project/" + P.slug : S.slug;
      if (key && h === "/editor/#" + key) a.setAttribute("aria-current", "page"); else if (h !== "/editor/") a.removeAttribute("aria-current");
    });
    const tab = document.querySelector(".tabbar .tab");
    if (tab) tab.innerHTML = P.slug ? esc(P.edit.name || "Untitled project") + (P.dirty ? '<span class="unsaved" title="Unsaved"></span>' : "")
      : esc(S.edit ? S.edit.title || "Untitled" : "Editor") + (S.dirty ? '<span class="unsaved" title="Unsaved"></span>' : "");
  }
  function gitPill(g) {
    if (!g || !g.repo) return '<span class="git-pill warn" title="Run git init in the Blog folder">Not a git repo</span>';
    if (!g.remote) return `<span class="git-pill warn" title="Add a GitHub remote to publish online">${esc(g.branch)} · no GitHub remote</span>`;
    if (g.ahead) return `<span class="git-pill warn">${g.ahead} commit${g.ahead > 1 ? "s" : ""} not pushed</span><button type="button" class="btn ghost" id="btn-push">Push</button>`;
    return `<span class="git-pill" title="${esc(g.remote)}">${esc(g.branch)} → GitHub</span>`;
  }

  /* ---------- load ---------- */
  async function load() {
    try { S.state = await call("GET", "/api/state"); }
    catch (e) { v.innerHTML = `<div class="view"><div class="col"><div class="empty"><strong>Editor server not reachable</strong><span>${esc(e.message)}</span></div></div></div>`; return; }
    route();
  }
  async function route() {
    const h = decodeURIComponent(location.hash.slice(1));
    if (S.dirty) await saveNow();
    if (P.dirty) await saveProject();
    if (h === "new-project") return newProject();
    if (h.startsWith("project/")) return openProjectRoute(h.slice(8));
    P.slug = null; P.edit = null;
    if (h === "new") return newPost();
    let slug = h;
    if (!slug) {
      const recent = [...S.state.posts].sort((a, b) => (b.mtime || 0) - (a.mtime || 0))[0];
      if (!recent) return emptyState();
      history.replaceState(null, "", "#" + recent.slug); slug = recent.slug;
    }
    if (slug === S.slug && $("ed-text")) return;
    try { const p = await call("GET", "/api/posts/" + encodeURIComponent(slug)); open(p); }
    catch (e) { v.innerHTML = `<div class="view"><div class="col"><div class="empty"><strong>No post at this address</strong><span>${esc(e.message)}</span><a class="btn" href="/editor/#new">New post</a></div></div></div>`; }
  }
  function emptyState() {
    v.innerHTML = '<div class="view"><div class="col"><div class="empty"><strong>Nothing to edit yet</strong><span>Start a post. It stays a draft on this Mac until you publish it.</span><a class="btn primary" href="/editor/#new">New post</a></div></div></div>';
  }
  async function newPost() {
    try { const { slug } = await call("POST", "/api/posts"); await refreshSidebar(); history.replaceState(null, "", "#" + slug); S.slug = null; await route(); setTimeout(() => $("f-title")?.focus(), 50); }
    catch (e) { toast(e.message); }
  }

  /* ---------- editor UI ---------- */
  function open(p) {
    P.slug = null; P.edit = null;
    S.slug = p.slug; S.dirty = false;
    S.edit = { title: p.title || "", series: p.series || "", part: p.part ?? null, date: p.date || "", publishAt: p.publishAt || "", tags: p.tags || [], summary: p.summary || "", body: p.body || "" };
    S.meta = { status: p.status, committed: p.committed, releaseAt: p.releaseAt, scheduled: p.scheduled };
    v.innerHTML =
      '<div class="ed-bar" role="toolbar" aria-label="Editor">' +
        '<div class="seg" role="group" aria-label="View mode"><button type="button" data-mode="source">Source</button><button type="button" data-mode="split">Split</button><button type="button" data-mode="reading">Reading</button></div>' +
        '<div class="fmt" aria-label="Formatting"><button type="button" class="h" data-fmt="h2" title="Heading 2">H2</button><button type="button" class="h" data-fmt="h3" title="Heading 3">H3</button><span class="vr"></span><button type="button" class="b" data-fmt="bold" title="Bold (⌘B)">B</button><button type="button" class="i" data-fmt="italic" title="Italic (⌘I)">I</button><button type="button" data-fmt="mark" title="Highlight">==</button><button type="button" class="m" data-fmt="code" title="Inline code">`c`</button><button type="button" class="m" data-fmt="block" title="Code block">```</button><span class="vr"></span><button type="button" data-fmt="link" title="Link (⌘K)">Link</button><button type="button" data-fmt="callout" title="Callout">Callout</button><button type="button" data-fmt="image" title="Add an image">Image</button></div>' +
        '<span class="grow"></span><span class="save-state" id="save-state" aria-live="polite">Saved</span><span id="git-slot" style="display:inline-flex;gap:6px;align-items:center"></span>' +
        '<div class="ed-actions"><span class="status" id="pub-state"></span><a class="btn ghost" id="btn-view" href="/posts/' + esc(p.slug) + '/">Preview page</a><button type="button" class="btn ghost" id="btn-unpublish">Unpublish</button><button type="button" class="btn ghost danger" id="btn-delete">Delete</button><button type="button" class="btn primary" id="btn-publish">Publish</button></div>' +
      '</div><div class="ed-confirm" id="ed-confirm" hidden></div>' +
      '<div class="ed-body" id="ed-body">' +
        '<div class="ed-pane ed-src" id="ed-src"><div class="ed-inner">' +
          '<textarea class="title-input" id="f-title" rows="1" placeholder="Untitled" aria-label="Title"></textarea>' +
          '<details class="ed-props" id="ed-props" open><summary>Properties</summary><div class="pf">' +
            '<label for="f-slug">address</label><input id="f-slug" autocomplete="off" spellcheck="false"><div class="hint" id="slug-hint"></div>' +
            '<label for="f-series">series</label><input id="f-series" placeholder="e.g. Phortisis" autocomplete="off">' +
            '<label for="f-part">part</label><input id="f-part" inputmode="numeric" placeholder="1" autocomplete="off">' +
            '<label for="f-date">date</label><input id="f-date" type="date"><div class="hint">Shown on the post. Filled in when you publish if left empty.</div>' +
            '<label for="f-release">release</label><input id="f-release" type="datetime-local"><div class="hint" id="release-hint">Empty: goes live when you publish. Set a time to schedule it.</div>' +
            '<label for="f-tags">tags</label><input id="f-tags" placeholder="zephyr, stm32" autocomplete="off" spellcheck="false">' +
            '<label for="f-summary">summary</label><textarea id="f-summary" rows="2" placeholder="One or two sentences for the post list"></textarea>' +
          "</div></details>" +
          '<textarea class="ed-text" id="ed-text" aria-label="Post body in Markdown" spellcheck="true" placeholder="Start writing in Markdown.&#10;&#10;Callouts: > [!tip] Title&#10;Highlights: ==like this==&#10;Footnotes: text[^1] and [^1]: the note&#10;Links to other posts: [[post-address]]&#10;&#10;Paste or drop an image to add it."></textarea>' +
          '<div class="ed-foot"><span id="ed-foot-count"></span><span><span class="kbd">⌘S</span> save</span><span><span class="kbd">⌘B</span> <span class="kbd">⌘I</span> <span class="kbd">⌘K</span></span><span>Drafts save to drafts/ as you type</span></div>' +
        "</div></div>" +
        '<div class="ed-pane ed-preview" id="ed-preview"><div class="ed-inner prose"><div class="eyebrow" id="pv-eyebrow"></div><h1 class="inline-title" style="margin-top:8px" id="pv-title"></h1><div id="pv-md"></div></div></div>' +
      "</div>" +
      '<input type="file" id="img-input" class="hidden-file" accept="image/*" multiple tabindex="-1" aria-hidden="true">';
    const e = S.edit;
    $("f-title").value = e.title; $("f-slug").value = p.slug; $("f-series").value = e.series; $("f-part").value = e.part ?? "";
    $("f-date").value = e.date; $("f-release").value = toLocalInput(e.publishAt); $("f-tags").value = e.tags.join(", "); $("f-summary").value = e.summary; $("ed-text").value = e.body;
    wire(); applyMode(); updateStatus(); updateFoot(); markCurrent();
    requestAnimationFrame(() => { grow($("f-title")); grow($("ed-text")); });
    // Re-measure the auto-growing fields whenever the writing column changes width.
    if (window.ResizeObserver) { let w = 0; new ResizeObserver((en) => { const nw = Math.round(en[0].contentRect.width); if (nw !== w) { w = nw; grow($("f-title")); grow($("ed-text")); } }).observe($("ed-src")); }
  }
  const grow = (el) => { if (!el) return; el.style.height = "auto"; el.style.height = el.scrollHeight + "px"; };
  function applyMode() {
    const m = S.mode, body = $("ed-body"); if (!body) return;
    body.className = "ed-body" + (m === "split" ? " split" : "");
    $("ed-src").hidden = m === "reading"; $("ed-preview").hidden = m === "source";
    document.querySelectorAll(".seg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === m)));
    preview(); if (m !== "reading") requestAnimationFrame(() => { grow($("ed-text")); grow($("f-title")); });
  }
  let pvSeq = 0;
  async function preview() {
    if (!S.edit || !$("ed-preview") || !$("ed-preview").offsetParent) return;
    const e = S.edit, seq = ++pvSeq;
    $("pv-title").textContent = e.title || "Untitled";
    $("pv-eyebrow").textContent = e.series ? e.series + (e.part !== null && e.part !== "" ? " · Part " + e.part : "") : "Post";
    try { const { html } = await call("POST", "/api/render", { body: e.body }); if (seq === pvSeq) $("pv-md").innerHTML = html; } catch {}
  }
  function updateFoot() { const el = $("ed-foot-count"); if (el) el.textContent = words(S.edit.body) + " words · " + readMins(S.edit.body) + " min read"; }
  function updateStatus() {
    const st = $("pub-state"); if (!st) return;
    const m = S.meta, future = isFuture(S.edit.publishAt);
    const label = m.status === "draft" ? ["", "Draft"] : m.status === "scheduled" && !S.dirty ? ["hold", "Scheduled · " + fmtWhen(m.releaseAt)] : m.status === "changed" || S.dirty && m.committed ? ["changed", "Unpublished edits"] : ["live", "Published"];
    st.className = "status " + label[0]; st.textContent = label[1];
    const btn = $("btn-publish");
    btn.textContent = future ? (m.committed ? "Update schedule" : "Schedule") : m.committed ? "Update post" : "Publish";
    btn.disabled = S.busy || (m.committed && m.status !== "changed" && !S.dirty && m.status !== "scheduled");
    $("btn-unpublish").hidden = !m.committed;
    $("btn-unpublish").textContent = m.status === "scheduled" ? "Cancel release" : "Unpublish";
    const sl = $("f-slug"); sl.readOnly = !!m.committed;
    $("slug-hint").textContent = m.committed ? "Unpublish to change the address." : "The post’s address: letters, numbers and hyphens."; $("slug-hint").classList.remove("err");
    $("release-hint").textContent = future ? "Goes live on the site at " + fmtWhen(S.edit.publishAt) + " (checked hourly)." : S.edit.publishAt ? "This time has passed, so it goes live when you publish." : "Empty: goes live when you publish. Set a time to schedule it.";
    $("git-slot").innerHTML = gitPill(S.state.git);
    const pb = $("btn-push"); if (pb) pb.onclick = doPush;
    markCurrent();
  }
  const setSave = (t, err) => { const el = $("save-state"); if (el) { el.textContent = t; el.classList.toggle("err", !!err); } };

  function markDirty() {
    S.dirty = true; setSave("Unsaved"); clearTimeout(saveT); saveT = setTimeout(saveNow, 900);
    clearTimeout(prevT); prevT = setTimeout(preview, 200); updateFoot(); updateStatus();
  }
  async function saveNow() {
    clearTimeout(saveT);
    if (S.saving) await S.saving;
    if (!S.dirty || !S.edit) return;
    S.dirty = false; setSave("Saving…");
    const slug = S.slug, snap = { ...S.edit };
    S.saving = call("PUT", "/api/posts/" + encodeURIComponent(slug), snap)
      .then((meta) => { if (S.slug === slug) { S.meta = meta; if (!S.dirty) setSave("Saved"); updateStatus(); } })
      .catch((e) => { if (S.slug === slug) { S.dirty = true; setSave("Couldn’t save: " + e.message, true); } })
      .finally(() => { S.saving = null; });
    await S.saving;
    refreshSidebar();
  }

  function wire() {
    const t = $("ed-text");
    document.querySelectorAll(".seg button").forEach((b) => (b.onclick = () => { S.mode = b.dataset.mode; try { localStorage.setItem("bench-mode", S.mode); } catch {} applyMode(); }));
    $("f-title").addEventListener("input", (ev) => { S.edit.title = ev.target.value.replace(/\n/g, " "); grow(ev.target); markDirty(); });
    $("f-title").addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); t.focus(); } });
    $("f-title").addEventListener("blur", () => { if (/^untitled(-\d+)?$/.test(S.slug) && !S.meta.committed && slugify(S.edit.title)) rename(slugify(S.edit.title)); });
    $("f-series").addEventListener("input", (ev) => { S.edit.series = ev.target.value.trim(); markDirty(); });
    $("f-part").addEventListener("input", (ev) => { const x = ev.target.value.trim(); S.edit.part = x === "" ? null : isNaN(Number(x)) ? x : Number(x); markDirty(); });
    $("f-date").addEventListener("input", (ev) => { S.edit.date = ev.target.value; markDirty(); });
    $("f-release").addEventListener("input", (ev) => { const x = ev.target.value; S.edit.publishAt = x ? new Date(x).toISOString() : ""; markDirty(); });
    $("f-tags").addEventListener("input", (ev) => { S.edit.tags = ev.target.value.split(",").map(slugify).filter(Boolean); markDirty(); });
    $("f-summary").addEventListener("input", (ev) => { S.edit.summary = ev.target.value; markDirty(); });
    $("f-slug").addEventListener("change", (ev) => { if (!ev.target.readOnly) rename(slugify(ev.target.value)); });
    t.addEventListener("input", () => { S.edit.body = t.value; grow(t); markDirty(); });
    t.addEventListener("keydown", (ev) => {
      if (!(ev.metaKey || ev.ctrlKey)) return; const k = ev.key.toLowerCase();
      if (k === "b") { ev.preventDefault(); fmt("bold"); } else if (k === "i") { ev.preventDefault(); fmt("italic"); } else if (k === "k") { ev.preventDefault(); fmt("link"); }
    });
    const imgs = (list) => [...(list || [])].filter((f) => f.type.startsWith("image/"));
    t.addEventListener("paste", (ev) => { const f = imgs(ev.clipboardData && ev.clipboardData.files); if (f.length) { ev.preventDefault(); upload(f); } });
    t.addEventListener("dragover", (ev) => { if ([...ev.dataTransfer.items].some((i) => i.kind === "file")) { ev.preventDefault(); t.classList.add("drop"); } });
    t.addEventListener("dragleave", () => t.classList.remove("drop"));
    t.addEventListener("drop", (ev) => { t.classList.remove("drop"); const f = imgs(ev.dataTransfer.files); if (f.length) { ev.preventDefault(); t.focus(); upload(f); } });
    $("img-input").addEventListener("change", (ev) => { const f = imgs(ev.target.files); ev.target.value = ""; if (f.length) upload(f); });
    document.querySelectorAll(".fmt button").forEach((b) => (b.onclick = () => fmt(b.dataset.fmt)));
    $("btn-publish").onclick = publish;
    $("btn-unpublish").onclick = () => confirmBar("unpublish");
    $("btn-delete").onclick = () => confirmBar("delete");
  }

  function insertText(text, a, b) {
    const t = $("ed-text"); t.focus();
    let ok = false; try { ok = document.execCommand("insertText", false, text); } catch {}
    if (!ok) { t.setRangeText(text, t.selectionStart, t.selectionEnd, "end"); t.dispatchEvent(new Event("input")); }
    if (a != null) { const base = t.selectionEnd - text.length; t.setSelectionRange(base + a, base + b); }
  }
  function fmt(kind) {
    if (kind === "image") return $("img-input").click();
    if (S.mode === "reading") { S.mode = "source"; applyMode(); }
    const t = $("ed-text"), s = t.selectionStart, e = t.selectionEnd, sel = t.value.slice(s, e);
    const wrap = (a, b, ph) => { const inner = sel || ph; insertText(a + inner + b, a.length, a.length + inner.length); };
    if (kind === "bold") wrap("**", "**", "bold text");
    else if (kind === "italic") wrap("*", "*", "italic text");
    else if (kind === "mark") wrap("==", "==", "highlight");
    else if (kind === "code") wrap("`", "`", "code");
    else if (kind === "link") { const inner = sel || "link text"; insertText("[" + inner + "](https://)", inner.length + 3, inner.length + 11); }
    else if (kind === "block") { const pre = s > 0 && t.value[s - 1] !== "\n" ? "\n" : ""; const inner = sel || "code"; insertText(pre + "```sh\n" + inner + "\n```\n", pre.length + 6, pre.length + 6 + inner.length); }
    else { const ls = t.value.lastIndexOf("\n", s - 1) + 1; t.setSelectionRange(ls, ls); const p = kind === "h2" ? "## " : kind === "h3" ? "### " : "> [!note] "; if (kind === "callout") insertText(p + "Title\n> ", p.length, p.length + 5); else insertText(p); }
  }
  async function upload(files) {
    for (const f of files) {
      const alt = (f.name || "image").replace(/\.[^.]+$/, "").replace(/[[\]]/g, "");
      const ph = "![Adding " + alt + "…]()"; insertText(ph + "\n");
      try { const r = await call("POST", "/api/images?name=" + encodeURIComponent(f.name || "image"), undefined, f); replaceInBody(ph, "![" + alt + "](" + r.path + ")"); }
      catch (e) { replaceInBody(ph + "\n", ""); toast(e.message); }
    }
  }
  function replaceInBody(a, b) {
    const t = $("ed-text"); if (!t) return; const i = t.value.indexOf(a); if (i < 0) return;
    const pos = t.selectionStart; t.value = t.value.slice(0, i) + b + t.value.slice(i + a.length); S.edit.body = t.value;
    const np = pos > i ? pos + (b.length - a.length) : pos; t.setSelectionRange(np, np); grow(t); markDirty();
  }
  async function rename(to) {
    const hint = $("slug-hint");
    if (!to || to === S.slug) { $("f-slug").value = S.slug; return; }
    await saveNow();
    try { const r = await call("POST", "/api/posts/" + encodeURIComponent(S.slug) + "/rename", { to }); S.slug = r.slug; history.replaceState(null, "", "#" + r.slug); $("f-slug").value = r.slug; $("btn-view").href = "/posts/" + r.slug + "/"; refreshSidebar(); }
    catch (e) { hint.textContent = e.message; hint.classList.add("err"); $("f-slug").value = S.slug; }
  }
  function showResult(r, okMsg) {
    const c = $("ed-confirm"); c.hidden = false;
    c.innerHTML = `<span>${esc(r.committed ? okMsg + " " : "")}${esc(r.note || "")}</span><span class="grow"></span>${r.pushed === false && S.state.git.remote ? '<button type="button" class="btn" id="c-push">Push</button>' : ""}<button type="button" class="btn ghost" id="c-close">Close</button>` + (r.log ? `<pre class="ed-log">${esc(r.log)}</pre>` : "");
    $("c-close").onclick = () => (c.hidden = true);
    const p = $("c-push"); if (p) p.onclick = doPush;
  }
  async function reloadMeta() {
    S.state = await call("GET", "/api/state");
    const p = await call("GET", "/api/posts/" + encodeURIComponent(S.slug)).catch(() => null);
    if (p) { S.meta = { status: p.status, committed: p.committed, releaseAt: p.releaseAt, scheduled: p.scheduled }; S.edit.date = p.date || S.edit.date; $("f-date").value = S.edit.date; }
    updateStatus(); refreshSidebar();
  }
  async function publish() {
    if (!S.edit.title.trim()) { toast("Give the post a title before publishing."); return $("f-title").focus(); }
    S.busy = true; updateStatus(); setSave("Publishing…");
    await saveNow();
    try {
      const r = await call("POST", "/api/posts/" + encodeURIComponent(S.slug) + "/publish");
      setSave("Saved");
      showResult(r, r.scheduled ? `Committed. Goes live ${fmtWhen(r.publishAt)}.` : "Committed.");
      toast(r.scheduled ? "Scheduled" : r.pushed ? "Published" : "Committed");
    } catch (e) { setSave(e.message, true); }
    S.busy = false; await reloadMeta();
  }
  function confirmBar(kind) {
    const c = $("ed-confirm"), title = esc(S.edit.title || "Untitled"); c.hidden = false;
    c.innerHTML = kind === "delete"
      ? `<span>Delete “${title}”${S.meta.committed ? " and remove it from the site with a commit" : ""}? The draft file is removed and can’t be recovered${S.meta.committed ? ", though the published version stays in git history" : ""}.</span><span class="grow"></span><button type="button" class="btn" id="c-no">Cancel</button><button type="button" class="btn primary" id="c-yes">Delete post</button>`
      : `<span>${S.meta.status === "scheduled" ? "Cancel the scheduled release of" : "Take"} “${title}” ${S.meta.status === "scheduled" ? "" : "off the site"}? It stays here as a draft, and the change is committed and pushed.</span><span class="grow"></span><button type="button" class="btn" id="c-no">Cancel</button><button type="button" class="btn primary" id="c-yes">${S.meta.status === "scheduled" ? "Cancel release" : "Unpublish"}</button>`;
    $("c-no").onclick = () => (c.hidden = true);
    $("c-yes").onclick = () => (kind === "delete" ? doDelete() : doUnpublish());
    $("c-yes").focus();
  }
  async function doUnpublish() {
    S.busy = true; updateStatus(); await saveNow();
    try { const r = await call("POST", "/api/posts/" + encodeURIComponent(S.slug) + "/unpublish"); showResult(r, "Unpublished."); }
    catch (e) { toast(e.message); }
    S.busy = false; await reloadMeta();
  }
  async function doDelete() {
    clearTimeout(saveT); S.dirty = false;
    try { const r = await call("DELETE", "/api/posts/" + encodeURIComponent(S.slug)); toast(r.committed ? "Deleted and committed" : "Deleted"); S.slug = null; S.edit = null; S.state = await call("GET", "/api/state"); await refreshSidebar(); location.hash = ""; route(); }
    catch (e) { toast(e.message); }
  }
  async function doPush() {
    const c = $("ed-confirm"); c.hidden = false; c.innerHTML = "<span>Pushing…</span>";
    try { const r = await call("POST", "/api/push"); showResult({ ...r, committed: false }, ""); } catch (e) { toast(e.message); }
    if (P.slug) await reloadProject(); else await reloadMeta();
  }

  document.addEventListener("keydown", (ev) => { if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "s") { if (P.edit) { ev.preventDefault(); saveProject(); } else if (S.edit) { ev.preventDefault(); saveNow(); } } });
  addEventListener("hashchange", route);
  addEventListener("beforeunload", (ev) => { if (S.dirty || P.dirty) { if (S.dirty) saveNow(); if (P.dirty) saveProject(); ev.preventDefault(); } });
  let rt; addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(preview, 200); });
  /* ---------- projects ---------- */
  // Project files are edited in place in content/projects/; Publish commits that one file and pushes.
  const P = { slug: null, edit: null, meta: null, dirty: false, saving: null, busy: false };
  let pSaveT, pPrevT;
  const STATUS = { "in-progress": "In progress", "on-hold": "On hold", ongoing: "Ongoing", done: "Done" };
  async function newProject() {
    try { const { slug } = await call("POST", "/api/projects"); await refreshSidebar(); history.replaceState(null, "", "#project/" + slug); P.slug = null; await openProjectRoute(slug); setTimeout(() => $("j-name")?.focus(), 50); }
    catch (e) { toast(e.message); }
  }
  async function openProjectRoute(slug) {
    if (P.slug === slug && $("j-name")) return;
    try { openProject(await call("GET", "/api/projects/" + encodeURIComponent(slug))); }
    catch (e) { v.innerHTML = `<div class="view"><div class="col"><div class="empty"><strong>No project at this address</strong><span>${esc(e.message)}</span><a class="btn" href="/editor/#new-project">New project</a></div></div></div>`; }
  }
  function openProject(p) {
    S.slug = null; S.edit = null; S.dirty = false;
    P.slug = p.slug; P.dirty = false; P.meta = { state: p.state };
    P.edit = { name: p.name || "", status: p.status || "in-progress", spec: p.spec || "", series: p.series || "", order: p.order ?? "", body: p.body || "" };
    const seriesNames = [...new Set((S.state.posts || []).map((x) => x.series).filter(Boolean))].sort();
    v.innerHTML =
      '<div class="ed-bar" role="toolbar" aria-label="Project editor">' +
        '<span class="eyebrow">Project</span><span class="grow"></span><span class="save-state" id="save-state" aria-live="polite">Saved</span><span id="git-slot" style="display:inline-flex;gap:6px;align-items:center"></span>' +
        '<div class="ed-actions"><span class="status" id="pub-state"></span><a class="btn ghost" href="/projects/">Preview page</a><button type="button" class="btn ghost danger" id="j-delete">Delete</button><button type="button" class="btn primary" id="j-publish">Publish</button></div>' +
      '</div><div class="ed-confirm" id="ed-confirm" hidden></div>' +
      '<div class="ed-body split" id="ed-body">' +
        '<div class="ed-pane ed-src"><div class="ed-inner">' +
          '<textarea class="title-input" id="j-name" rows="1" placeholder="Project name" aria-label="Project name"></textarea>' +
          '<details class="ed-props" open><summary>Properties</summary><div class="pf">' +
            '<label for="j-slug">address</label><input id="j-slug" autocomplete="off" spellcheck="false"><div class="hint" id="j-slug-hint"></div>' +
            '<label for="j-status">status</label><select id="j-status">' + Object.entries(STATUS).map(([k, l]) => `<option value="${k}">${l}</option>`).join("") + '</select>' +
            '<label for="j-spec">specs</label><input id="j-spec" placeholder="e.g. 45 × 38.5 mm · 2-layer · KiCad" autocomplete="off"><div class="hint">The small monospace line at the bottom of the card.</div>' +
            '<label for="j-series">series</label><input id="j-series" list="j-series-list" placeholder="e.g. Phortisis" autocomplete="off"><datalist id="j-series-list">' + seriesNames.map((x) => `<option value="${esc(x)}">`).join("") + '</datalist><div class="hint">Links the card to the first published post in this series.</div>' +
            '<label for="j-order">order</label><input id="j-order" inputmode="numeric" placeholder="1" autocomplete="off"><div class="hint">Lower numbers come first on the Projects page.</div>' +
          '</div></details>' +
          '<textarea class="ed-text short" id="j-body" aria-label="Project description in Markdown" placeholder="A sentence or two about the project. Markdown works."></textarea>' +
        '</div></div>' +
        '<div class="ed-pane ed-preview"><div class="ed-inner"><div class="eyebrow" style="margin-bottom:12px">Card preview</div><div class="proj-preview" id="j-card"></div></div></div>' +
      '</div>';
    const e = P.edit;
    $("j-name").value = e.name; $("j-slug").value = p.slug; $("j-status").value = e.status; $("j-spec").value = e.spec; $("j-series").value = e.series; $("j-order").value = e.order; $("j-body").value = e.body;
    const field = (id, key, fn = (x) => x) => $(id).addEventListener("input", (ev) => { P.edit[key] = fn(ev.target.value); if (id === "j-name" || id === "j-body") grow(ev.target); projectDirty(); });
    field("j-name", "name", (x) => x.replace(/\n/g, " ")); field("j-spec", "spec"); field("j-series", "series", (x) => x.trim()); field("j-order", "order", (x) => x.trim()); field("j-body", "body");
    $("j-status").addEventListener("change", (ev) => { P.edit.status = ev.target.value; projectDirty(); });
    $("j-name").addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); $("j-body").focus(); } });
    $("j-name").addEventListener("blur", () => { if (/^new-project(-\d+)?$/.test(P.slug) && P.meta.state === "new" && slugify(P.edit.name)) renameProject(slugify(P.edit.name)); });
    $("j-slug").addEventListener("change", (ev) => { if (!ev.target.readOnly) renameProject(slugify(ev.target.value)); });
    $("j-publish").onclick = publishProject;
    $("j-delete").onclick = confirmProjectDelete;
    projectStatus(); cardPreview(); markCurrent();
    requestAnimationFrame(() => { grow($("j-name")); grow($("j-body")); });
  }
  function projectStatus() {
    const st = $("pub-state"); if (!st || !P.meta) return;
    const s = P.meta.state, dirty = P.dirty;
    const [cls, label] = s === "new" ? ["", "Not published"] : s === "changed" || dirty ? ["changed", "Unpublished changes"] : ["live", "Published"];
    st.className = "status " + cls; st.textContent = label;
    const b = $("j-publish"); b.textContent = s === "new" ? "Publish" : "Publish changes"; b.disabled = P.busy || (s === "published" && !dirty);
    const sl = $("j-slug"); sl.readOnly = s !== "new";
    $("j-slug-hint").textContent = s !== "new" ? "Published projects keep their address." : "Letters, numbers and hyphens."; $("j-slug-hint").classList.remove("err");
    $("git-slot").innerHTML = gitPill(S.state.git); const pb = $("btn-push"); if (pb) pb.onclick = doPush;
    markCurrent();
  }
  async function cardPreview() {
    try { const { html } = await call("POST", "/api/projects/" + encodeURIComponent(P.slug) + "/card", P.edit); const el = $("j-card"); if (el) el.innerHTML = html; } catch {}
  }
  function projectDirty() {
    P.dirty = true; setSave("Unsaved"); clearTimeout(pSaveT); pSaveT = setTimeout(saveProject, 900);
    clearTimeout(pPrevT); pPrevT = setTimeout(cardPreview, 200); projectStatus();
  }
  async function saveProject() {
    clearTimeout(pSaveT);
    if (P.saving) await P.saving;
    if (!P.dirty || !P.edit) return;
    P.dirty = false; setSave("Saving…");
    const slug = P.slug, snap = { ...P.edit };
    P.saving = call("PUT", "/api/projects/" + encodeURIComponent(slug), snap)
      .then((meta) => { if (P.slug === slug) { P.meta = { state: meta.state }; if (!P.dirty) setSave("Saved"); projectStatus(); } })
      .catch((e) => { if (P.slug === slug) { P.dirty = true; setSave("Couldn’t save: " + e.message, true); } })
      .finally(() => { P.saving = null; });
    await P.saving; refreshSidebar();
  }
  async function renameProject(to) {
    if (!to || to === P.slug) { $("j-slug").value = P.slug; return; }
    await saveProject();
    try { const r = await call("POST", "/api/projects/" + encodeURIComponent(P.slug) + "/rename", { to }); P.slug = r.slug; history.replaceState(null, "", "#project/" + r.slug); $("j-slug").value = r.slug; refreshSidebar(); }
    catch (e) { const h = $("j-slug-hint"); h.textContent = e.message; h.classList.add("err"); $("j-slug").value = P.slug; }
  }
  async function reloadProject() {
    S.state = await call("GET", "/api/state");
    const p = await call("GET", "/api/projects/" + encodeURIComponent(P.slug)).catch(() => null);
    if (p) P.meta = { state: p.state };
    projectStatus(); refreshSidebar();
  }
  async function publishProject() {
    if (!P.edit.name.trim()) { toast("Give the project a name before publishing."); return $("j-name").focus(); }
    P.busy = true; projectStatus(); setSave("Publishing…");
    await saveProject();
    try { const r = await call("POST", "/api/projects/" + encodeURIComponent(P.slug) + "/publish"); setSave("Saved"); showResult(r, "Committed."); toast(r.pushed ? "Published" : "Committed"); }
    catch (e) { setSave(e.message, true); }
    P.busy = false; await reloadProject();
  }
  function confirmProjectDelete() {
    const c = $("ed-confirm"), name = esc(P.edit.name || "Untitled project"), live = P.meta.state !== "new"; c.hidden = false;
    c.innerHTML = `<span>Delete “${name}”${live ? " and remove it from the site with a commit" : ""}? The file is removed${live ? ", though the published version stays in git history" : " and can’t be recovered"}.</span><span class="grow"></span><button type="button" class="btn" id="c-no">Cancel</button><button type="button" class="btn primary" id="c-yes">Delete project</button>`;
    $("c-no").onclick = () => (c.hidden = true);
    $("c-yes").onclick = async () => {
      clearTimeout(pSaveT); P.dirty = false;
      try { const r = await call("DELETE", "/api/projects/" + encodeURIComponent(P.slug)); toast(r.committed ? "Deleted and committed" : "Deleted"); P.slug = null; P.edit = null; S.state = await call("GET", "/api/state"); await refreshSidebar(); location.hash = ""; route(); }
      catch (e) { toast(e.message); }
    };
    $("c-yes").focus();
  }

  load();
})();
