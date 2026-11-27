// Checks the live site: is it up, how fast is the home page, do all internal links,
// images and in-page anchors work, and is every post that should be released actually live.
// Run locally with `npm run check`; GitHub Actions runs it hourly (.github/workflows/monitor.yml).
// Exits 1 if anything is wrong.
import fs from "node:fs";
import { loadPublished } from "./site.mjs";

const SITE = new URL(process.env.SITE_URL || "https://aquila-const.github.io/");
if (!SITE.pathname.endsWith("/")) SITE.pathname += "/";
const MAX_PAGES = 500;
const TIMEOUT_MS = 15000;

const errors = [];
const pages = new Map(); // url -> { status, ms, ids }
const assets = new Map(); // url -> status
let external = 0;

const inScope = (u) => u.origin === SITE.origin && u.pathname.startsWith(SITE.pathname);
const isPage = (u) => u.pathname.endsWith("/") || u.pathname.endsWith(".html");
const short = (u) => String(u).replace(SITE.origin, "");

async function get(url, method = "GET") {
  for (let attempt = 1; ; attempt++) {
    const t0 = performance.now();
    try {
      const res = await fetch(url, { method, redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "User-Agent": "bench-log-monitor" } });
      const body = method === "GET" ? await res.text() : "";
      return { status: res.status, ms: Math.round(performance.now() - t0), type: res.headers.get("content-type") || "", body };
    } catch (e) {
      if (attempt >= 2) return { status: 0, ms: Math.round(performance.now() - t0), type: "", body: "", error: e.name === "TimeoutError" ? "timed out" : e.message };
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function checkAsset(u, from) {
  const key = u.href;
  if (assets.has(key)) return;
  assets.set(key, null);
  let r = await get(key, "HEAD");
  if (r.status === 405 || r.status === 0) r = await get(key);
  assets.set(key, r.status);
  if (r.status !== 200) errors.push({ url: short(key), problem: r.error || `HTTP ${r.status}`, from: short(from) });
}

async function crawl() {
  const queue = [{ url: SITE.href, from: "(start)" }];
  while (queue.length && pages.size < MAX_PAGES) {
    const { url, from } = queue.shift();
    if (pages.has(url)) continue;
    const r = await get(url);
    const ids = new Set([...r.body.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    pages.set(url, { status: r.status, ms: r.ms, ids });
    if (r.status !== 200) { errors.push({ url: short(url), problem: r.error || `HTTP ${r.status}`, from: short(from) }); continue; }
    if (!r.type.includes("html")) continue;
    for (const m of r.body.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
      const raw = m[1].replace(/&amp;/g, "&");
      if (/^(mailto:|tel:|javascript:|data:)/i.test(raw)) continue;
      let u;
      try { u = new URL(raw, url); } catch { errors.push({ url: raw, problem: "malformed link", from: short(url) }); continue; }
      if (raw.startsWith("#")) {
        const id = decodeURIComponent(raw.slice(1));
        if (id && !ids.has(id)) errors.push({ url: raw, problem: "anchor not found on page", from: short(url) });
        continue;
      }
      if (!inScope(u)) { if (/^https?:$/.test(u.protocol)) external++; continue; }
      u.hash = "";
      if (isPage(u)) { if (!pages.has(u.href)) queue.push({ url: u.href, from: url }); }
      else await checkAsset(u, url);
    }
  }
}

await crawl();

// Every committed post whose release time has passed must be live. Timed releases go live at the next
// hourly deploy, and scheduled runs can start late, so a release only counts after a grace period.
const GRACE_MIN = Number(process.env.RELEASE_GRACE_MIN) || 90;
const expected = loadPublished(Date.now() - GRACE_MIN * 60000).map((p) => new URL(`posts/${p.slug}/`, SITE).href);
for (const url of expected) {
  if (!pages.has(url)) {
    const r = await get(url);
    pages.set(url, { status: r.status, ms: r.ms, ids: new Set() });
    errors.push({ url: short(url), problem: r.status === 200 ? "live but not linked from the site" : `should be released but is ${r.error || "HTTP " + r.status}`, from: "content/posts" });
  }
}

/* ---------- report ---------- */
const home = pages.get(SITE.href);
const ok = errors.length === 0;
const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
const line = [now, ok ? "ok" : "fail", pages.size, assets.size, errors.length, home ? home.ms : ""].join(",");

console.log(`${ok ? "OK" : "FAIL"}  ${SITE.href}`);
console.log(`pages ${pages.size} · assets ${assets.size} · external links skipped ${external} · home ${home ? home.ms + " ms" : "unreachable"} · expected posts ${expected.length}`);
for (const e of errors) console.log(`  ✗ ${e.url}  ${e.problem}  (from ${e.from})`);

if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `line=${line}\nstatus=${ok ? "ok" : "fail"}\n`);
if (process.env.GITHUB_STEP_SUMMARY) {
  let md = `### ${ok ? "✅ Site OK" : "❌ Site has problems"}\n\n| Pages | Assets | Home page | Expected posts | Problems |\n| ---: | ---: | ---: | ---: | ---: |\n| ${pages.size} | ${assets.size} | ${home ? home.ms + " ms" : "down"} | ${expected.length} | ${errors.length} |\n`;
  if (errors.length) md += `\n| URL | Problem | Found on |\n| --- | --- | --- |\n` + errors.map((e) => `| \`${e.url}\` | ${e.problem} | \`${e.from}\` |`).join("\n") + "\n";
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
}
process.exit(ok ? 0 : 1);
