// Bench Log: content loading, Markdown rendering and page templates.
// Shared by the production build (scripts/build.mjs) and the local editor server (scripts/dev.mjs).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Marked } from "marked";
import hljs from "highlight.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DIRS = {
  posts: path.join(ROOT, "content/posts"),
  images: path.join(ROOT, "content/images"),
  projects: path.join(ROOT, "content/projects"),
  drafts: path.join(ROOT, "drafts"),
  theme: path.join(ROOT, "theme"),
};
export const SITE = {
  name: "Bench Log",
  tagline: "Embedded · Hardware · Apple platforms",
  // Your GoatCounter code: the "benchlog" in https://benchlog.goatcounter.com. Empty turns analytics off.
  goatcounter: "benchlog",
};
const GOATCOUNTER_CODE = /^[a-z0-9-]+$/i.test(SITE.goatcounter) ? SITE.goatcounter : "";

const RESERVED = new Set(["editor", "projects", "posts", "images", "theme", "api", "index"]);
export const validSlug = (s) => typeof s === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s) && s.length <= 80 && !RESERVED.has(s);
export function slugify(s) {
  return String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
export const words = (md) => (String(md || "").replace(/```[\s\S]*?```/g, " ").match(/[A-Za-z0-9'’-]+/g) || []).length;
export const fmtRelease = (iso) => { const d = new Date(iso); return isNaN(d) ? String(iso) : d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }); };
export const readMins =(md) => Math.max(1, Math.round(words(md) / 220));

/* ---------------- front matter ----------------
   Obsidian-compatible YAML subset: one `key: value` per line. Strings are written JSON-quoted,
   tags as a JSON array, so the file stays valid YAML and Obsidian shows it as Properties. */
const FIELDS = ["title", "series", "part", "date", "publishAt", "tags", "summary"];
/** A post with `publishAt` in the future is committed but left out of the live build until then. */
export const isReleased = (p, now = Date.now()) => !p.publishAt || !(Date.parse(p.publishAt) > now);
export function parsePost(text, slug) {
  const meta = { title: "", series: "", part: null, date: "", publishAt: "", tags: [], summary: "" };
  let body = String(text || "").replace(/^﻿/, "");
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(body);
  if (m) {
    body = body.slice(m[0].length);
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
      if (!kv) continue;
      let [, k, v] = kv;
      v = v.trim();
      let val = v;
      if (/^["[]/.test(v) || /^-?\d+(\.\d+)?$/.test(v) || v === "null") { try { val = JSON.parse(v); } catch { val = v.replace(/^"|"$/g, ""); } }
      else if (/^'.*'$/.test(v)) val = v.slice(1, -1);
      if (k === "tags") val = Array.isArray(val) ? val.map(String) : String(val).split(",").map((t) => t.trim()).filter(Boolean);
      meta[k] = val;
    }
  }
  return { slug, ...meta, part: meta.part === "" ? null : meta.part, body: body.replace(/^\n+/, "") };
}
export function serializePost(p) {
  const lines = ["---"];
  for (const k of FIELDS) {
    const v = p[k];
    if (k === "part") { if (v !== null && v !== undefined && v !== "") lines.push(`part: ${typeof v === "number" ? v : JSON.stringify(String(v))}`); continue; }
    if (k === "tags") { lines.push(`tags: ${JSON.stringify((v || []).map(String))}`); continue; }
    if ((k === "date" || k === "publishAt") && !v) continue;
    lines.push(`${k}: ${JSON.stringify(String(v ?? ""))}`);
  }
  lines.push("---", "");
  return lines.join("\n") + String(p.body || "").replace(/\s*$/, "\n");
}

/* ---------------- content ---------------- */
function readDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => {
    const slug = f.slice(0, -3);
    const file = path.join(dir, f);
    return { ...parsePost(fs.readFileSync(file, "utf8"), slug), mtime: fs.statSync(file).mtimeMs };
  }).filter((p) => validSlug(p.slug));
}
/** Every post the editor knows about, with its status. */
export function loadAll() {
  const pub = new Map(readDir(DIRS.posts).map((p) => [p.slug, p]));
  const drafts = new Map(readDir(DIRS.drafts).map((p) => [p.slug, p]));
  const out = [];
  for (const slug of new Set([...pub.keys(), ...drafts.keys()])) {
    const live = pub.get(slug), draft = drafts.get(slug);
    const changed = !!(live && draft && serializePost(live) !== serializePost(draft));
    const scheduled = !!(live && !isReleased(live));
    out.push({ ...(draft || live), live: !!live && !scheduled, committed: !!live, scheduled, releaseAt: live ? live.publishAt : "", changed, hasDraft: !!draft,
      status: !live ? "draft" : changed ? "changed" : scheduled ? "scheduled" : "published" });
  }
  return out;
}
/** Posts that are committed and whose release time has passed: what the live site shows. */
/* ---------------- projects ----------------
   content/projects/<slug>.md: front matter (name, status, spec, series, order) and a short Markdown description. */
export const PROJECT_STATUS = { "in-progress": ["progress", "In progress"], "on-hold": ["hold", "On hold"], ongoing: ["", "Ongoing"], done: ["live", "Done"] };
export function parseProject(text, slug) {
  const p = parsePost(text, slug);
  return { slug, name: String(p.name || ""), status: PROJECT_STATUS[p.status] ? p.status : "in-progress", spec: String(p.spec || ""), series: String(p.series || ""),
    order: p.order === null || p.order === undefined || p.order === "" || isNaN(Number(p.order)) ? null : Number(p.order), body: p.body };
}
export function serializeProject(p) {
  const lines = ["---", `name: ${JSON.stringify(String(p.name || ""))}`, `status: ${JSON.stringify(PROJECT_STATUS[p.status] ? p.status : "in-progress")}`, `spec: ${JSON.stringify(String(p.spec || ""))}`];
  if (p.series) lines.push(`series: ${JSON.stringify(String(p.series))}`);
  if (p.order !== null && p.order !== undefined && p.order !== "" && !isNaN(Number(p.order))) lines.push(`order: ${Number(p.order)}`);
  lines.push("---", "");
  return lines.join("\n") + String(p.body || "").replace(/\s*$/, "\n");
}
export function loadProjects() {
  if (!fs.existsSync(DIRS.projects)) return [];
  return fs.readdirSync(DIRS.projects).filter((f) => f.endsWith(".md")).map((f) => parseProject(fs.readFileSync(path.join(DIRS.projects, f), "utf8"), f.slice(0, -3)))
    .filter((p) => validSlug(p.slug))
    .sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || a.name.localeCompare(b.name));
}

export function loadPublished(now = Date.now()) { return readDir(DIRS.posts).filter((p) => isReleased(p, now)).map((p) => ({ ...p, live: true })); }

const byDate = (a, b) => String(b.date || "").localeCompare(String(a.date || "")) || (b.mtime || 0) - (a.mtime || 0);
const seriesLabel = (p) => (p.series ? p.series + (p.part !== null && p.part !== undefined && p.part !== "" ? " · Part " + p.part : "") : "Post");
const partNum = (p) => Number(p.part) || 0;

/* ---------------- markdown ---------------- */
function extractFootnotes(md) {
  const out = [], notes = [];
  let fence = null;
  for (const line of String(md || "").split("\n")) {
    const f = /^\s*(```|~~~)/.exec(line);
    if (f) { fence = fence ? (line.trim().startsWith(fence) ? null : fence) : f[1]; out.push(line); continue; }
    const m = !fence && /^\[\^([\w-]+)\]:\s?(.*)$/.exec(line);
    if (m) notes.push({ id: m[1], text: m[2] }); else out.push(line);
  }
  return { body: out.join("\n"), notes };
}

/**
 * Render post Markdown to HTML. `R` is the relative path from the page to the site root,
 * used to resolve `images/...` and `[[post]]` links so the site works under any GitHub Pages path.
 * Returns { html, headings }.
 */
export function renderMarkdown(md, R = "") {
  const { body, notes } = extractFootnotes(md);
  const fnIndex = new Map(notes.map((n, i) => [n.id, i + 1]));
  const headings = [];
  const seen = new Map();
  const resolve = (href) => (/^images\//.test(href) ? R + href : href);
  const marked = new Marked({ gfm: true });
  marked.use({
    extensions: [
      { name: "mark", level: "inline", start: (s) => { const i = s.indexOf("=="); return i < 0 ? undefined : i; },
        tokenizer(s) { const m = /^==(?=\S)([^\n]*?\S)==/.exec(s); if (m) return { type: "mark", raw: m[0], tokens: this.lexer.inlineTokens(m[1]) }; },
        renderer(t) { return "<mark>" + this.parser.parseInline(t.tokens) + "</mark>"; } },
      { name: "wikilink", level: "inline", start: (s) => { const i = s.indexOf("[["); return i < 0 ? undefined : i; },
        tokenizer(s) { const m = /^\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/.exec(s); if (m) return { type: "wikilink", raw: m[0], target: m[1].trim(), label: (m[2] || m[1]).trim() }; },
        renderer(t) { return `<a class="internal" href="${R}posts/${esc(slugify(t.target))}/">${esc(t.label)}</a>`; } },
      { name: "fnref", level: "inline", start: (s) => { const i = s.indexOf("[^"); return i < 0 ? undefined : i; },
        tokenizer(s) { const m = /^\[\^([\w-]+)\]/.exec(s); if (m) return { type: "fnref", raw: m[0], id: m[1] }; },
        renderer(t) { const n = fnIndex.get(t.id); return n ? `<sup class="fnref"><a href="#fn-${esc(t.id)}" id="fnref-${esc(t.id)}">${n}</a></sup>` : esc(t.raw); } },
    ],
    renderer: {
      heading(text, level, raw) {
        let id = "h-" + (slugify(raw) || "section");
        const n = (seen.get(id) || 0) + 1; seen.set(id, n); if (n > 1) id += "-" + n;
        if (level === 2 || level === 3) headings.push({ id, text: raw.replace(/[*_`=]/g, ""), level });
        return `<h${level} id="${id}">${text}</h${level}>\n`;
      },
      code(code, info) {
        const lang = (info || "").trim().split(/\s+/)[0];
        let html = esc(code);
        if (lang && hljs.getLanguage(lang)) { try { html = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value; } catch {} }
        return `<pre${lang ? ` data-lang="${esc(lang)}"` : ""}><code${lang ? ` class="language-${esc(lang)}"` : ""}>${html}</code></pre>\n`;
      },
      blockquote(quote) {
        const m = /^<p>\[!([a-zA-Z-]+)\][+-]?[ \t]*([^\n<]*)\n?/.exec(quote);
        if (!m) return `<blockquote>\n${quote}</blockquote>\n`;
        const rest = quote.slice(m[0].length).replace(/^<\/p>\n?/, "");
        const inner = /^\s*$/.test(rest) ? "" : rest.startsWith("<") ? rest : "<p>" + rest;
        return `<div class="callout ${esc(m[1].toLowerCase())}"><div class="eyebrow">${m[2].trim() || esc(m[1])}</div>${inner}</div>\n`;
      },
      table(header, body) { return `<div class="table-wrap"><table><thead>${header}</thead><tbody>${body}</tbody></table></div>\n`; },
      link(href, title, text) {
        const ext = /^https?:\/\//.test(href || "");
        return `<a href="${esc(resolve(href || ""))}"${title ? ` title="${esc(title)}"` : ""}${ext ? ' target="_blank" rel="noopener"' : ""}>${text}</a>`;
      },
      image(href, title, text) {
        // A Markdown image title becomes a visible caption: ![alt](images/x.jpg "Caption")
        return `<img src="${esc(resolve(href || ""))}" alt="${esc(text)}" loading="lazy">${title ? `<span class="caption">${esc(title)}</span>` : ""}`;
      },
    },
  });
  let html = marked.parse(body);
  if (notes.length) {
    html += '<div class="footnotes"><div class="eyebrow">Notes</div><ol>' +
      notes.map((n) => `<li id="fn-${esc(n.id)}">${marked.parseInline(n.text)} <a class="fn-back" href="#fnref-${esc(n.id)}" aria-label="Back to text">↩</a></li>`).join("") + "</ol></div>";
  }
  return { html, headings };
}

/* ---------------- templates ---------------- */
const FOOTER = `<footer class="site"><span class="fs-name">${SITE.name}</span><span class="fs-credit"><span>Inspired by the <a href="https://github.com/joostmbakker" target="_blank" rel="noopener">Basalt theme for Obsidian</a> by Joost Bakker.</span><span>Set in Basalt Serif, Geist and Geist Mono.</span>${GOATCOUNTER_CODE ? `<span>Anonymous, cookie-free visit counts by <a href="https://www.goatcounter.com" target="_blank" rel="noopener">GoatCounter</a>.</span>` : ""}</span></footer>`;

function sidebar(posts, R, active, opts) {
  const top = [["home", "Home", R || "./"], ["projects", "Projects", R + "projects/"]];
  if (opts.editor) top.push(["editor", "Editor", "/editor/"]);
  let h = `<nav class="nav-group top"><div class="nav-heading">Vault</div>` +
    top.map(([k, l, href]) => `<a class="nav-item" href="${href}"${active === k ? ' aria-current="page"' : ""}><span class="t">${l}</span></a>`).join("") + `</nav>`;
  if (opts.editor) h += `<nav class="nav-group series-g"><div class="nav-heading"><span>Writing</span><a class="nav-new" href="/editor/#new">+ New post</a></div></nav>`;
  const groups = new Map();
  for (const p of posts) { const g = p.series || "Posts"; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(p); }
  for (const [g, items] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    items.sort((a, b) => partNum(a) - partNum(b) || String(a.title).localeCompare(String(b.title)));
    h += `<nav class="nav-group series-g"><div class="nav-heading">${esc(g)}</div>` + items.map((p) => {
      const label = (p.part !== null && p.part !== undefined && p.part !== "" ? `Part ${p.part} · ` : "") + (p.title || "Untitled");
      const href = opts.editorLinks ? `/editor/#${p.slug}` : `${R}posts/${p.slug}/`;
      return `<a class="nav-item indent${p.live ? " live" : ""}${p.changed ? " changed" : ""}${p.scheduled ? " scheduled" : ""}" href="${href}"${active === p.slug ? ' aria-current="page"' : ""}><span class="dot"></span><span class="t">${esc(label)}</span></a>`;
    }).join("") + `</nav>`;
  }
  if (opts.editor && opts.projects) {
    h += `<nav class="nav-group series-g"><div class="nav-heading"><span>Projects</span><a class="nav-new" href="/editor/#new-project">+ New project</a></div>` +
      opts.projects.map((p) => `<a class="nav-item indent${p.state === "published" ? " live" : p.state === "changed" ? " changed" : ""}" href="/editor/#project/${p.slug}"${active === "project/" + p.slug ? ' aria-current="page"' : ""}><span class="dot"></span><span class="t">${esc(p.name || "Untitled project")}</span></a>`).join("") + `</nav>`;
  }
  if (opts.editor) h += `<div class="side-foot"><div><i class="l"></i>Published</div><div><i class="c"></i>Published, with unpublished edits</div><div><i class="s"></i>Scheduled</div><div><i></i>Draft</div></div>`;
  return h;
}

export function shell({ title, R, posts, active, tab, main, outline = [], opts = {}, description = "", scripts = [] }) {
  const ol = outline.length > 1;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
${description ? `<meta name="description" content="${esc(description)}">` : ""}
<link rel="stylesheet" href="${R}theme/basalt.css">
<link rel="icon" href="${R}theme/favicon.svg" type="image/svg+xml">
<script>try{var t=localStorage.getItem("bench-theme");if(t)document.documentElement.dataset.theme=t}catch(e){}</script>
</head>
<body>
<div class="app">
  <aside class="sidebar" aria-label="Site navigation">
    <div class="brand"><a href="${R || "./"}">${SITE.name}</a><button class="pill-btn" id="theme-btn" type="button" aria-label="Switch light or dark theme">Theme</button></div>
    ${sidebar(posts, R, active, opts)}
  </aside>
  <div class="main${ol ? " has-outline" : ""}" id="main">
    <div class="tabbar" aria-hidden="true"><span class="tab on">${esc(tab)}</span></div>
    ${main}
    ${ol ? `<aside class="outline" aria-label="Outline"><div class="eyebrow" style="padding:0 8px 8px">Outline</div><div class="outline-inner">${outline.map((h) => `<a class="h${h.level}" href="#${h.id}">${esc(h.text)}</a>`).join("")}</div></aside>` : ""}
  </div>
</div>
<script src="${R}theme/site.js"></script>
${GOATCOUNTER_CODE && !opts.editor ? `<script data-goatcounter="https://${GOATCOUNTER_CODE}.goatcounter.com/count" async src="//gc.zgo.at/count.js"></script>` : ""}
${scripts.map((s) => `<script src="${s}"></script>`).join("\n")}
</body>
</html>
`;
}

function homeMain(posts, R, opts) {
  const sorted = [...posts].sort(byDate);
  const live = sorted.filter((p) => p.live);
  const feat = live[0];
  const tags = [...new Set(sorted.flatMap((p) => p.tags || []))].sort();
  const link = (p) => `${R}posts/${p.slug}/`;
  let h = `<section class="view"><div class="col"><div class="hero"><div class="eyebrow">${SITE.tagline}</div><h1 class="inline-title">${SITE.name}</h1><p>Build logs from a small bench of projects I am working on. Each project is written up as a post, with detailed explanations of each process.</p></div>`;
  if (feat) h += `<a class="featured" href="${link(feat)}"><div class="meta-row"><span class="status live">Latest</span><span>${esc(seriesLabel(feat))}</span><span class="sep"></span><span>${esc(feat.date || "")}</span><span class="sep"></span><span>${readMins(feat.body)} min read</span></div><h2>${esc(feat.title)}</h2>${feat.summary ? `<p>${esc(feat.summary)}</p>` : ""}<span class="readmore">Read it</span></a>`;
  h += `<div class="section-head"><h2>All posts</h2><div class="filters" id="filters" role="group" aria-label="Filter posts by tag">${tags.map((t) => `<button type="button" class="tag" data-tag="${esc(t)}" aria-pressed="false">${esc(t)}</button>`).join("")}</div></div>`;
  if (!sorted.length) h += `<div class="empty"><strong>No posts yet</strong><span>Check back soon.</span></div>`;
  else h += `<div class="list" id="post-list">` + sorted.map((p) => `<div class="row${p.live ? "" : " draft"}" data-tags="${esc((p.tags || []).join(" "))}"><div class="when">${p.live ? esc(p.date || "") : p.scheduled ? '<span class="status hold">Scheduled</span>' : '<span class="status">Draft</span>'}</div><div style="min-width:0"><div class="eyebrow" style="font-size:10.5px">${esc(seriesLabel(p))}</div><h3><a href="${link(p)}">${esc(p.title || "Untitled")}</a></h3>${p.summary ? `<p>${esc(p.summary)}</p>` : ""}<div class="tags">${(p.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}${p.changed ? '<span class="status changed">Edited</span>' : ""}${opts.editor ? `<a class="edit-link" href="/editor/#${p.slug}">Edit</a>` : ""}</div></div></div>`).join("") + `<div class="empty" id="no-match" hidden>No posts with this tag yet.</div></div>`;
  return h + FOOTER + `</div></section>`;
}

function postMain(p, posts, R, opts) {
  const { html, headings } = renderMarkdown(p.body, R);
  const same = p.series ? posts.filter((x) => x.series === p.series).sort((a, b) => partNum(a) - partNum(b)) : [];
  const i = same.findIndex((x) => x.slug === p.slug), prev = i > 0 ? same[i - 1] : null, next = i >= 0 ? same[i + 1] : null;
  const link = (x) => `${R}posts/${x.slug}/`;
  let h = `<section class="view"><article class="col prose">`;
  const ST = { published: ["live", "Published"], changed: ["changed", "Has unpublished edits"], scheduled: ["hold", "Scheduled"], draft: ["", "Draft"] }[p.status || "published"];
  if (opts.editor) h += `<div class="post-actions"><a class="btn" href="/editor/#${p.slug}">Edit post</a><span class="status ${ST[0]}">${ST[1]}</span></div>`;
  if (p.scheduled) h += `<div class="banner">Scheduled preview. This goes live on the site at ${esc(fmtRelease(p.releaseAt))}.</div>`;
  else if (!p.live) h += `<div class="banner">Draft preview. This page only exists on your machine until you publish it.</div>`;
  h += `<div class="eyebrow">${esc(seriesLabel(p))}</div><h1 class="inline-title" style="margin-top:8px">${esc(p.title || "Untitled")}</h1><dl class="props">` +
    (p.date ? `<dt>published</dt><dd>${esc(p.date)}</dd>` : "") + `<dt>reading time</dt><dd>${readMins(p.body)} min</dd>` +
    ((p.tags || []).length ? `<dt>tags</dt><dd>${p.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</dd>` : "") + `</dl>${html}`;
  if (same.length > 1) h += `<div class="series"><div class="eyebrow">The ${esc(p.series)} series</div><ol>${same.map((x) => `<li class="${x.slug === p.slug ? "cur" : ""}"><b>${x.part !== null && x.part !== undefined && x.part !== "" ? "Part " + esc(x.part) : ""}</b>${x.slug === p.slug ? esc(x.title) : x.live || opts.editor ? `<a href="${link(x)}">${esc(x.title)}</a>` : esc(x.title)}${x.live ? "" : " (draft)"}</li>`).join("")}</ol></div>`;
  h += `<nav class="pager">${prev ? `<a href="${link(prev)}">← ${esc(prev.title)}</a>` : `<a href="${R || "./"}">← All posts</a>`}${next ? `<a href="${link(next)}">${esc(next.title)} →</a>` : ""}</nav>`;
  return { main: h + FOOTER + `</article></section>`, headings };
}

export function projectCard(p, posts, R, opts = {}) {
  const [cls, label] = PROJECT_STATUS[p.status] || PROJECT_STATUS["in-progress"];
  const first = p.series ? posts.filter((x) => x.series === p.series && x.live).sort((a, b) => partNum(a) - partNum(b))[0] : null;
  const links = [first ? `<a href="${R}posts/${first.slug}/">Read the ${esc(p.series)} series</a>` : "", opts.editor ? `<a href="/editor/#project/${p.slug}">Edit</a>` : ""].filter(Boolean);
  return `<div class="card"><div class="top"><h3>${esc(p.name || "Untitled project")}</h3><span class="status ${cls}">${label}</span></div>` +
    `<div class="card-body">${renderMarkdown(p.body || "", R).html}</div>` + (p.spec ? `<div class="spec">${esc(p.spec)}</div>` : "") +
    (links.length ? `<div class="card-links">${links.join("")}</div>` : "") + `</div>`;
}
function projectsMain(projects, posts, R, opts) {
  return `<section class="view"><div class="col"><div class="eyebrow">On the bench</div><h1 class="inline-title" style="margin-top:8px">Projects</h1><p style="margin-top:14px;color:var(--muted);max-width:58ch">The hardware and apps the posts are written about. Each one gets its own series.</p>` +
    (projects.length ? `<div class="projects">${projects.map((p) => projectCard(p, posts, R, opts)).join("\n")}</div>` : `<div class="empty"><strong>No projects yet</strong></div>`) + `${FOOTER}</div></section>`;
}

/**
 * Build every page into a Map of site path -> {body, type}.
 * opts.drafts: include unpublished drafts (local preview only). opts.editor: add editor links.
 */
export function buildPages(opts = {}) {
  const posts = opts.drafts ? loadAll() : loadPublished();
  const pages = new Map();
  const put = (p, body) => pages.set(p, { body, type: "text/html; charset=utf-8" });
  put("index.html", shell({ title: SITE.name, R: "", posts, active: "home", tab: "Home", main: homeMain(posts, "", opts), opts, description: "Build logs on Zephyr, KiCad boards and Swift apps that talk to hardware." }));
  put("projects/index.html", shell({ title: `Projects · ${SITE.name}`, R: "../", posts, active: "projects", tab: "Projects", main: projectsMain(loadProjects(), posts, "../", opts), opts }));
  for (const p of posts) {
    const { main, headings } = postMain(p, posts, "../../", opts);
    put(`posts/${p.slug}/index.html`, shell({ title: `${p.title || "Untitled"} · ${SITE.name}`, R: "../../", posts, active: p.slug, tab: p.title || "Untitled", main, outline: headings, opts, description: p.summary }));
  }
  put("404.html", shell({ title: `Not found · ${SITE.name}`, R: "", posts, active: "", tab: "Not found", opts,
    main: `<section class="view"><div class="col"><div class="empty"><strong>This page isn’t here</strong><span>It may have moved, or the post isn’t published yet.</span></div>${FOOTER}</div></section>` }));
  return { pages, posts };
}


/** Images referenced by a post body as images/<file>. */
export function referencedImages(md) {
  return [...new Set([...String(md || "").matchAll(/\]\((images\/[^)\s]+)\)/g)].map((m) => m[1]))];
}
