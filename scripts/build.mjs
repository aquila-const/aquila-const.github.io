// Production build: writes the public site to dist/ (published, released posts only; no editor).
// GitHub Actions runs this on every push and on an hourly schedule so timed releases go live on their own.
import fs from "node:fs";
import path from "node:path";
import { ROOT, DIRS, buildPages } from "./site.mjs";

const OUT = path.join(ROOT, "dist");
fs.rmSync(OUT, { recursive: true, force: true });

const { pages, posts } = buildPages({ drafts: false, editor: false });
for (const [rel, { body }] of pages) {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}
const copyDir = (from, to, skip = () => false) => {
  if (!fs.existsSync(from)) return;
  fs.cpSync(from, to, { recursive: true, filter: (src) => !skip(src) });
};
copyDir(DIRS.theme, path.join(OUT, "theme"), (src) => src.endsWith("editor.js"));
copyDir(DIRS.images, path.join(OUT, "images"), (src) => path.basename(src).startsWith("."));
fs.writeFileSync(path.join(OUT, ".nojekyll"), "");

console.log(`Built ${pages.size} pages (${posts.length} published posts) into dist/`);
