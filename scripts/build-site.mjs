#!/usr/bin/env node
// Assembles the GitHub Pages site: the landing page, both guides, and the files
// the pages link to (the demo videos) -- nothing else. A page that links to a file
// that is not there fails the build, so a broken link is never published.
//
//   node scripts/build-site.mjs              writes _site/
//   node scripts/build-site.mjs --out <dir>
//
// The guides are built first (npm run guide, npm run guide:litellm).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TRACKS } from "./verify/tracks.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outFlag = process.argv.indexOf("--out");
const OUT = path.resolve(ROOT, outFlag >= 0 ? process.argv[outFlag + 1] : "_site");

// The landing page is self-contained apart from its links to the guides.
const PAGES = [
  { source: path.join("site", "index.html"), name: "index.html" },
  ...Object.values(TRACKS).map((track) => ({ source: track.guide, name: track.guide })),
];

// A relative URL in src, href or poster: not a data: URI, another site or a fragment.
const URL_ATTRIBUTE = /\b(?:src|href|poster)="(?![a-z][a-z0-9+.-]*:|#|\/\/)([^"#?]+)/gi;

const inside = (directory, file) => file.startsWith(directory + path.sep);

function copy(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

for (const page of PAGES) {
  const source = path.join(ROOT, page.source);
  if (!fs.existsSync(source)) throw new Error(`Missing ${page.source}. Build the guides first: npm run guide && npm run guide:litellm`);
  copy(source, path.join(OUT, page.name));
}

// The pages sit at the root of the site, so a link names the same path in the repository.
const broken = new Set();
for (const page of PAGES) {
  const html = fs.readFileSync(path.join(OUT, page.name), "utf8");
  for (const [, link] of html.matchAll(URL_ATTRIBUTE)) {
    const target = decodeURI(link);
    const source = path.resolve(ROOT, target);
    const destination = path.resolve(OUT, target);
    if (target.startsWith("/") || !inside(OUT, destination) || !inside(ROOT, source)) {
      broken.add(`${page.name}: ${link} (a link must stay inside the site and not start with /, which breaks under /<repository>/)`);
    } else if (fs.existsSync(destination)) {
      continue;
    } else if (fs.existsSync(source) && fs.statSync(source).isFile()) {
      copy(source, destination);
    } else {
      broken.add(`${page.name}: ${link} (no such file)`);
    }
  }
}
if (broken.size > 0) {
  fs.rmSync(OUT, { recursive: true, force: true });
  console.error(`Not publishing: ${broken.size} broken link(s)\n  ${[...broken].join("\n  ")}`);
  process.exit(1);
}

const files = [];
(function list(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) list(file);
    else files.push(file);
  }
})(OUT);
const megabytes = (bytes) => (bytes / 1024 / 1024).toFixed(2);
for (const file of files.sort()) console.log(`${megabytes(fs.statSync(file).size).padStart(7)} MB  ${path.relative(OUT, file)}`);
console.log(`${files.length} files, ${megabytes(files.reduce((sum, file) => sum + fs.statSync(file).size, 0))} MB -> ${path.relative(ROOT, OUT) || "."}`);
