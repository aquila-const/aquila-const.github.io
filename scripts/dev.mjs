// Local editor + preview server. Run `npm run dev`, open http://localhost:4321/editor/
// Listens on 127.0.0.1 only. Publishing writes content/posts/<slug>.md, commits it and pushes to GitHub,
// where .github/workflows/deploy.yml builds and deploys the site to GitHub Pages.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import {
  ROOT, DIRS, SITE, buildPages, loadAll, parsePost, serializePost, renderMarkdown, referencedImages,
  validSlug, slugify, today, isReleased, shell, esc,
  loadProjects, parseProject, serializeProject, PROJECT_STATUS, projectCard, loadPublished,
} from "./site.mjs";

const PORT = Number(process.env.PORT) || 4322;
const HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const ORIGINS = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);
const MIME = { ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".txt": "text/plain; charset=utf-8" };
const IMAGE_EXT = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/svg+xml": ".svg", "image/avif": ".avif" };
fs.mkdirSync(DIRS.drafts, { recursive: true });
fs.mkdirSync(DIRS.images, { recursive: true });
fs.mkdirSync(DIRS.projects, { recursive: true });

/* ---------------- git ---------------- */
function git(args, { timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd: ROOT, timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout, stderr) =>
      resolve({ ok: !err, code: err ? err.code : 0, out: String(stdout).trim(), err: String(stderr).trim() }));
  });
}
async function gitStatus() {
  const inRepo = await git(["rev-parse", "--is-inside-work-tree"]);
  if (!inRepo.ok) return { repo: false };
  const top = await git(["rev-parse", "--show-toplevel"]);
  const branch = (await git(["branch", "--show-current"])).out || "(detached)";
  const remote = await git(["remote", "get-url", "origin"]);
  const up = await git(["rev-list", "--count", "@{upstream}..HEAD"]);
  const hasHead = (await git(["rev-parse", "--verify", "HEAD"])).ok;
  return { repo: true, top: top.out, branch, remote: remote.ok ? remote.out : null, upstream: up.ok, ahead: up.ok ? Number(up.out) : hasHead && remote.ok ? null : 0 };
}
async function push() {
  const st = await gitStatus();
  if (!st.repo) return { pushed: false, note: "This folder isn’t a git repository." };
  if (!st.remote) return { pushed: false, note: "Committed on this Mac. There’s no GitHub remote yet, so nothing was pushed." };
  const r = await git(["push", "-u", "origin", "HEAD"], { timeout: 90000 });
  if (r.ok) return { pushed: true, note: `Pushed to ${st.branch}. GitHub Pages will update in a minute or two.`, log: r.err || r.out };
  return { pushed: false, note: "Committed on this Mac, but the push failed. Fix the problem below, then use Push.", log: r.err || r.out };
}
async function commitPaths(paths, message, { remove = [] } = {}) {
  const st = await gitStatus();
  if (!st.repo) return { committed: false, pushed: false, note: "Saved, but this folder isn’t a git repository, so nothing was committed." };
  if (remove.length) { const r = await git(["rm", "-q", "--ignore-unmatch", "--", ...remove]); if (!r.ok) return { committed: false, note: "git rm failed.", log: r.err }; }
  if (paths.length) { const a = await git(["add", "--", ...paths]); if (!a.ok) return { committed: false, note: "git add failed.", log: a.err }; }
  const staged = await git(["diff", "--cached", "--quiet", "--", ...paths, ...remove]);
  if (staged.ok) return { committed: false, ...(await push()), note: "Nothing new to commit. The site already has this version." };
  const c = await git(["commit", "-m", message, "--", ...paths, ...remove]);
  if (!c.ok) return { committed: false, note: "git commit failed.", log: c.err || c.out };
  return { committed: true, message, ...(await push()) };
}

/* ---------------- content files ---------------- */
const draftFile = (slug) => path.join(DIRS.drafts, slug + ".md");
const postFile = (slug) => path.join(DIRS.posts, slug + ".md");
const relPost = (slug) => path.relative(ROOT, postFile(slug));
const readPost = (file, slug) => (fs.existsSync(file) ? parsePost(fs.readFileSync(file, "utf8"), slug) : null);
function current(slug) {
  const entry = loadAll().find((p) => p.slug === slug);
  if (!entry) return null;
  const src = readPost(draftFile(slug), slug) || readPost(postFile(slug), slug);
  return { ...src, status: entry.status, committed: entry.committed, releaseAt: entry.releaseAt, scheduled: entry.scheduled };
}
function cleanMeta(b) {
  const part = b.part === "" || b.part === null || b.part === undefined ? null : isNaN(Number(b.part)) ? String(b.part) : Number(b.part);
  let publishAt = "";
  if (b.publishAt) { const t = Date.parse(b.publishAt); if (!isNaN(t)) publishAt = new Date(t).toISOString(); }
  return {
    title: String(b.title || "").slice(0, 300), series: String(b.series || "").slice(0, 120), part,
    date: /^\d{4}-\d{2}-\d{2}$/.test(b.date || "") ? b.date : "", publishAt,
    tags: Array.isArray(b.tags) ? b.tags.map((t) => slugify(t)).filter(Boolean).slice(0, 20) : [],
    summary: String(b.summary || "").slice(0, 1000), body: String(b.body || ""),
  };
}

/* ---------------- projects ----------------
   Project files are edited in place in content/projects/. Publish commits just that file and pushes. */
const projectFile = (slug) => path.join(DIRS.projects, slug + ".md");
const relProject = (slug) => path.relative(ROOT, projectFile(slug));
async function projectStates() {
  const st = await gitStatus();
  const map = new Map();
  if (st.repo) {
    const r = await git(["status", "--porcelain", "--untracked-files=all", "--", "content/projects"]);
    for (const line of r.out.split("\n").filter(Boolean)) {
      const code = line.slice(0, 2), file = line.slice(3).trim().replace(/^"|"$/g, "");
      const slug = path.basename(file, ".md");
      map.set(slug, code.includes("?") || code.includes("A") ? "new" : code.includes("D") ? "deleted" : "changed");
    }
  }
  return loadProjects().map((p) => ({ ...p, state: !st.repo ? "changed" : map.get(p.slug) || "published" }));
}
function cleanProject(b) {
  return { name: String(b.name || "").slice(0, 200), status: PROJECT_STATUS[b.status] ? b.status : "in-progress", spec: String(b.spec || "").slice(0, 200),
    series: String(b.series || "").slice(0, 120), order: b.order === "" || b.order === null || b.order === undefined || isNaN(Number(b.order)) ? null : Number(b.order),
    body: String(b.body || "").slice(0, 20000) };
}
async function projectApi(req, res, m, parts) {
  if (parts.length === 1 && m === "GET") return send(res, 200, { projects: (await projectStates()).map(({ body, ...p }) => p) });
  if (parts.length === 1 && m === "POST") {
    let n = 1, slug = "new-project";
    while (fs.existsSync(projectFile(slug))) slug = `new-project-${++n}`;
    const order = Math.max(0, ...loadProjects().map((p) => p.order || 0)) + 1;
    fs.writeFileSync(projectFile(slug), serializeProject({ name: "", status: "in-progress", spec: "", series: "", order, body: "" }));
    return send(res, 200, { slug });
  }
  if (parts.length === 1 && m === "PUT") return fail(res, 405, "Not allowed.");
  const slug = parts[1], action = parts[2];
  if (!validSlug(slug)) return fail(res, 400, "That project address isn’t valid.");
  const find = async () => (await projectStates()).find((p) => p.slug === slug);
  if (action === "card" && m === "POST") {
    const p = cleanProject(await readJson(req));
    return send(res, 200, { html: projectCard({ ...p, slug }, loadPublished(), "../") });
  }
  const cur = await find();
  if (!cur) return fail(res, 404, "No project at this address.");
  if (!action && m === "GET") return send(res, 200, cur);
  if (!action && m === "PUT") {
    fs.writeFileSync(projectFile(slug), serializeProject(cleanProject(await readJson(req))));
    const { body, ...rest } = await find();
    return send(res, 200, rest);
  }
  if (action === "rename" && m === "POST") {
    const { to } = await readJson(req);
    if (cur.state !== "new") return fail(res, 409, "Published projects keep their address.");
    if (!validSlug(to)) return fail(res, 400, "Use letters, numbers and hyphens.");
    if (fs.existsSync(projectFile(to))) return fail(res, 409, "Another project already uses that address.");
    fs.renameSync(projectFile(slug), projectFile(to));
    return send(res, 200, { slug: to });
  }
  if (action === "publish" && m === "POST") {
    if (!cur.name.trim()) return fail(res, 400, "Give the project a name before publishing.");
    try { buildPages({ drafts: false }); } catch (e) { return fail(res, 500, "The site failed to build with this project: " + e.message); }
    return send(res, 200, await commitPaths([relProject(slug)], `${cur.state === "new" ? "Add" : "Update"} project: ${cur.name}`));
  }
  if (!action && m === "DELETE") {
    const tracked = (await git(["ls-files", "--error-unmatch", relProject(slug)])).ok;
    if (!tracked) { fs.rmSync(projectFile(slug), { force: true }); return send(res, 200, { committed: false, note: "Project deleted." }); }
    return send(res, 200, await commitPaths([], `Remove project: ${cur.name || slug}`, { remove: [relProject(slug)] }));
  }
  return fail(res, 405, "Not allowed.");
}

/* ---------------- http helpers ---------------- */
const send = (res, status, body, type = "application/json") => {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
};
const fail = (res, status, error) => send(res, status, { error });
function readBody(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on("data", (c) => { n += c.length; if (n > limit) { reject(new Error("too_large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
const readJson = async (req) => JSON.parse((await readBody(req, 2 * 1024 * 1024)).toString("utf8") || "{}");
function serveFile(res, file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, "Not found", "text/plain");
  res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
  fs.createReadStream(file).pipe(res);
}
const inside = (base, p) => { const r = path.resolve(base, p); return r.startsWith(base + path.sep) ? r : null; };

/* ---------------- editor page ---------------- */
async function editorPage() {
  const posts = loadAll();
  return shell({ title: `Editor · ${SITE.name}`, R: "../", posts, active: "editor", tab: "Editor", opts: { editor: true, editorLinks: true, projects: await projectStates() },
    main: `<section class="view editor" id="v-editor"><div class="view"><div class="col"><div class="loading-line" style="width:50%"></div><div class="loading-line" style="width:80%"></div></div></div></section>`,
    scripts: ["/theme/editor.js"] });
}

/* ---------------- api ---------------- */
async function api(req, res, url) {
  const m = req.method;
  const parts = url.pathname.split("/").filter(Boolean).slice(1); // after "api"
  if (m !== "GET") {
    if (req.headers["x-bench-editor"] !== "1") return fail(res, 403, "Missing editor header.");
    if (req.headers.origin && !ORIGINS.has(req.headers.origin)) return fail(res, 403, "Requests from other sites are refused.");
  }
  if (parts[0] === "state" && m === "GET") {
    return send(res, 200, { posts: loadAll().map(({ body, ...p }) => p), git: await gitStatus() });
  }
  if (parts[0] === "render" && m === "POST") {
    const { body } = await readJson(req);
    return send(res, 200, { html: renderMarkdown(String(body || ""), "../").html });
  }
  if (parts[0] === "push" && m === "POST") return send(res, 200, await push());
  if (parts[0] === "images" && m === "POST") {
    const ext = IMAGE_EXT[(req.headers["content-type"] || "").split(";")[0]];
    if (!ext) return fail(res, 415, "That file isn’t a supported image (PNG, JPEG, GIF, WebP, SVG or AVIF).");
    let buf; try { buf = await readBody(req); } catch { return fail(res, 413, "Images can be at most 25 MB."); }
    const base = slugify(String(url.searchParams.get("name") || "image").replace(/\.[^.]+$/, "")) || "image";
    const name = `${base}-${crypto.randomBytes(3).toString("hex")}${ext}`;
    fs.writeFileSync(path.join(DIRS.images, name), buf);
    return send(res, 200, { path: `images/${name}` });
  }
  if (parts[0] === "projects") return await projectApi(req, res, m, parts);
  if (parts[0] !== "posts") return fail(res, 404, "Unknown endpoint.");

  if (parts.length === 1 && m === "POST") {
    let n = 1, slug = "untitled";
    const taken = new Set(loadAll().map((p) => p.slug));
    while (taken.has(slug)) slug = `untitled-${++n}`;
    fs.writeFileSync(draftFile(slug), serializePost({ title: "", series: "", part: null, date: "", publishAt: "", tags: [], summary: "", body: "" }));
    return send(res, 200, { slug });
  }
  const slug = parts[1];
  if (!validSlug(slug)) return fail(res, 400, "That post address isn’t valid.");
  const action = parts[2];

  if (!action && m === "GET") { const p = current(slug); return p ? send(res, 200, p) : fail(res, 404, "No post at this address."); }
  if (!action && m === "PUT") {
    if (!current(slug)) return fail(res, 404, "No post at this address.");
    const p = cleanMeta(await readJson(req));
    fs.writeFileSync(draftFile(slug), serializePost(p));
    const { body, ...rest } = current(slug);
    return send(res, 200, rest);
  }
  if (action === "rename" && m === "POST") {
    const { to } = await readJson(req);
    const cur = current(slug);
    if (!cur) return fail(res, 404, "No post at this address.");
    if (cur.committed) return fail(res, 409, "Unpublish the post before changing its address.");
    if (!validSlug(to)) return fail(res, 400, "Use letters, numbers and hyphens, and avoid editor, projects, posts and images.");
    if (current(to)) return fail(res, 409, "Another post already uses that address.");
    fs.renameSync(draftFile(slug), draftFile(to));
    return send(res, 200, { slug: to });
  }
  if (action === "publish" && m === "POST") {
    const cur = current(slug);
    if (!cur) return fail(res, 404, "No post at this address.");
    if (!cur.title.trim()) return fail(res, 400, "Give the post a title before publishing.");
    const p = cleanMeta(cur);
    if (!p.date) p.date = p.publishAt ? new Date(p.publishAt).toLocaleDateString("en-CA") : today();
    const wasCommitted = cur.committed;
    fs.writeFileSync(postFile(slug), serializePost(p));
    fs.rmSync(draftFile(slug), { force: true });
    try { buildPages({ drafts: false }); } catch (e) { return fail(res, 500, "The site failed to build with this post: " + e.message); }
    const imgs = referencedImages(p.body).map((r) => path.join("content", r)).filter((r) => fs.existsSync(path.join(ROOT, r)));
    const future = p.publishAt && !isReleased(p);
    const verb = future ? "Schedule" : wasCommitted ? "Update" : "Publish";
    const result = await commitPaths([relPost(slug), ...imgs], `${verb}: ${p.title}${future ? ` (goes live ${p.publishAt})` : ""}`);
    return send(res, 200, { ...result, scheduled: !!future, publishAt: p.publishAt, date: p.date });
  }
  if (action === "unpublish" && m === "POST") {
    const cur = current(slug);
    if (!cur || !cur.committed) return fail(res, 404, "This post isn’t published.");
    if (!fs.existsSync(draftFile(slug))) fs.copyFileSync(postFile(slug), draftFile(slug));
    const st = await gitStatus();
    if (!st.repo) { fs.rmSync(postFile(slug), { force: true }); return send(res, 200, { committed: false, note: "Moved back to drafts. This folder isn’t a git repository, so nothing was committed." }); }
    const tracked = (await git(["ls-files", "--error-unmatch", relPost(slug)])).ok;
    if (!tracked) { fs.rmSync(postFile(slug), { force: true }); return send(res, 200, { committed: false, note: "Moved back to drafts. It was never committed." }); }
    return send(res, 200, await commitPaths([], `Unpublish: ${cur.title}`, { remove: [relPost(slug)] }));
  }
  if (!action && m === "DELETE") {
    const cur = current(slug);
    if (!cur) return fail(res, 404, "No post at this address.");
    fs.rmSync(draftFile(slug), { force: true });
    if (!cur.committed) return send(res, 200, { committed: false, note: "Draft deleted." });
    const tracked = (await git(["ls-files", "--error-unmatch", relPost(slug)])).ok;
    if (!tracked) { fs.rmSync(postFile(slug), { force: true }); return send(res, 200, { committed: false, note: "Post deleted." }); }
    return send(res, 200, await commitPaths([], `Delete: ${cur.title}`, { remove: [relPost(slug)] }));
  }
  return fail(res, 405, "Not allowed.");
}

/* ---------------- server ---------------- */
const server = http.createServer(async (req, res) => {
  try {
    if (!HOSTS.has(req.headers.host || "")) return send(res, 403, "Open the editor at http://localhost:" + PORT + "/editor/", "text/plain");
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const p = decodeURIComponent(url.pathname);
    if (p.startsWith("/api/")) return await api(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Not allowed", "text/plain");
    if (p === "/editor" ) { res.writeHead(302, { Location: "/editor/" }); return res.end(); }
    if (p === "/editor/") return send(res, 200, await editorPage(), "text/html; charset=utf-8");
    if (p.startsWith("/theme/")) { const f = inside(DIRS.theme, p.slice(7)); return f ? serveFile(res, f) : send(res, 404, "Not found", "text/plain"); }
    if (p.startsWith("/images/")) { const f = inside(DIRS.images, p.slice(8)); return f ? serveFile(res, f) : send(res, 404, "Not found", "text/plain"); }
    const { pages } = buildPages({ drafts: true, editor: true });
    let key = p.replace(/^\//, "");
    if (key === "" || key.endsWith("/")) key += "index.html";
    const page = pages.get(key) || pages.get(key + "/index.html");
    if (page) return send(res, 200, page.body, page.type);
    return send(res, 404, pages.get("404.html").body.replace(/href="theme\//g, 'href="/theme/').replace(/src="theme\//g, 'src="/theme/'), "text/html; charset=utf-8");
  } catch (e) {
    console.error(e);
    if (!res.headersSent) fail(res, 500, "Something went wrong on the editor server: " + e.message);
  }
});
server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  ${SITE.name} editor:  http://localhost:${PORT}/editor/\n  Site preview:       http://localhost:${PORT}/\n`);
});
